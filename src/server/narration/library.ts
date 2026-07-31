import { ulid } from 'ulid';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrationLibrary, narrationLibraryUses } from '../db/schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { fingerprintFor } from './fingerprint.js';
import { projectName } from './slots.js';
import type { NarrationLibraryPort } from './dispatch.js';
import type { NarratableEvent, NarrationOutput } from './types.js';

function eventFingerprint(event: NarratableEvent, pack: ContextPack): string {
  return fingerprintFor({
    event_type: event.event_type,
    error_signature: event.signature ?? '',
    tier: pack.stakes.tier,
    detail_level: pack.voice.detail_level,
    language: pack.voice.language ?? 'en',
  });
}

/**
 * Library phrasings are stored with the project-name slot left open —
 * `{project}` — so one graduated phrasing serves every project that hits
 * the same fingerprint. Fill at serve time.
 */
function fillSlots(output: NarrationOutput, pack: ContextPack): NarrationOutput {
  return { ...output, fragment: output.fragment.replaceAll('{project}', projectName(pack)) };
}

function openSlots(output: NarrationOutput, pack: ContextPack): NarrationOutput {
  return { ...output, fragment: output.fragment.replaceAll(projectName(pack), '{project}') };
}

export class DbNarrationLibrary implements NarrationLibraryPort {
  constructor(private db: Db) {}

  fingerprint(event: NarratableEvent, pack: ContextPack): string {
    return eventFingerprint(event, pack);
  }

  async lookup(orgId: string, event: NarratableEvent, pack: ContextPack) {
    // Per-pack glossary overrides outrank the global library (brief).
    const overrides = pack.voice.glossary_overrides ?? [];
    const signature = `${event.event_type} ${event.signature ?? ''}`.toLowerCase();
    const override = overrides.find((o) => signature.includes(o.term.toLowerCase()));
    if (override) {
      return {
        output: { fragment: `${projectName(pack)}: ${override.preferred_phrasing}` },
        source: 'glossary' as const,
        fingerprint: eventFingerprint(event, pack),
      };
    }

    const fingerprint = eventFingerprint(event, pack);
    const [entry] = await this.db
      .select()
      .from(narrationLibrary)
      .where(eq(narrationLibrary.fingerprint, fingerprint))
      .limit(1);

    if (!entry || entry.status !== 'graduated') return null;

    await this.recordUse(entry.id, orgId);
    return { output: fillSlots(entry.phrasing as NarrationOutput, pack), source: 'library' as const, fingerprint };
  }

  /** Every successful LLM fragment on a LIB row seeds (or reinforces) a candidate. */
  async writeCandidate(orgId: string, event: NarratableEvent, pack: ContextPack, output: NarrationOutput): Promise<void> {
    const fingerprint = eventFingerprint(event, pack);
    const [existing] = await this.db
      .select()
      .from(narrationLibrary)
      .where(eq(narrationLibrary.fingerprint, fingerprint))
      .limit(1);

    if (!existing) {
      const id = ulid();
      await this.db.insert(narrationLibrary).values({
        id,
        fingerprint,
        phrasing: openSlots(output, pack),
      });
      await this.recordUse(id, orgId);
      return;
    }

    // Retired entries stay retired — a negative tap sent this fingerprint
    // back to the LLM path permanently until a human re-reviews.
    if (existing.status === 'retired') return;
    await this.recordUse(existing.id, orgId);
  }

  private async recordUse(libraryId: string, orgId: string): Promise<void> {
    await this.db
      .insert(narrationLibraryUses)
      .values({ libraryId, orgId, count: 1 })
      .onConflictDoUpdate({
        target: [narrationLibraryUses.libraryId, narrationLibraryUses.orgId],
        set: { count: sql`${narrationLibraryUses.count} + 1` },
      });
    await this.db
      .update(narrationLibrary)
      .set({ useCount: sql`${narrationLibrary.useCount} + 1`, updatedAt: new Date() })
      .where(eq(narrationLibrary.id, libraryId));
    await this.maybeGraduate(libraryId);
  }

  /**
   * Graduation rule v2 — breadth and time, not just silence.
   *
   * Silence is NOT consent. This product has no positive feedback signal by
   * design (two negative taps and nothing else), so "zero complaints" is a
   * necessary condition for promotion, never evidence of approval. v1 treated
   * it as evidence: `total >= 5` let one org emit the same phrasing five times
   * in an afternoon — one flaky build failing repeatedly — and promote it
   * globally for every other tenant, with no human having affirmed it and
   * quite possibly no human having read it (uses are counted on emission, not
   * on delivery).
   *
   * v2 requires what silence cannot supply: the phrasing must have been used
   * across at least two organisations, at least three times, and must have
   * existed for at least a week. A burst inside one tenant now graduates
   * nothing. The library is global, so promotion should require cross-org
   * evidence — repetition within a single org says nothing about whether the
   * wording works for anyone else.
   */
  private static readonly MIN_ORGS = 2;
  private static readonly MIN_USES = 3;
  private static readonly MIN_EXPOSURE_MS = 7 * 24 * 60 * 60 * 1000;

  private async maybeGraduate(libraryId: string): Promise<void> {
    const [entry] = await this.db.select().from(narrationLibrary).where(eq(narrationLibrary.id, libraryId)).limit(1);
    if (!entry || entry.status !== 'candidate' || entry.negativeFeedbackCount > 0) return;

    const uses = await this.db.select().from(narrationLibraryUses).where(eq(narrationLibraryUses.libraryId, libraryId));
    const orgCount = uses.length;
    const total = uses.reduce((sum, u) => sum + u.count, 0);
    const exposedMs = Date.now() - new Date(entry.createdAt).getTime();

    const graduates =
      orgCount >= DbNarrationLibrary.MIN_ORGS &&
      total >= DbNarrationLibrary.MIN_USES &&
      exposedMs >= DbNarrationLibrary.MIN_EXPOSURE_MS;
    if (graduates) {
      await this.db
        .update(narrationLibrary)
        .set({ status: 'graduated', updatedAt: new Date() })
        .where(and(eq(narrationLibrary.id, libraryId), eq(narrationLibrary.status, 'candidate')));
    }
  }

  /** A negative feedback tap retires the entry back to the LLM path (deliverable 5 calls this). */
  async retireByFingerprint(fingerprint: string): Promise<boolean> {
    const [entry] = await this.db.select().from(narrationLibrary).where(eq(narrationLibrary.fingerprint, fingerprint)).limit(1);
    if (!entry) return false;
    await this.db
      .update(narrationLibrary)
      .set({
        status: 'retired',
        negativeFeedbackCount: sql`${narrationLibrary.negativeFeedbackCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(narrationLibrary.id, entry.id));
    return true;
  }
}
