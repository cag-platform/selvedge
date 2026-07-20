import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrations, narrationLibrary, packs } from '../db/schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { NarrationOutput } from '../narration/types.js';

// A learned meaning that hasn't recurred in this long is "possibly stale,
// still assumed" — surfaced, never silently trusted forever (anti-rot).
const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LearnedSignature = {
  event_type: string;
  /** The graduated plain-English meaning, project slot filled. */
  plain: string;
  times_seen: number;
  first_seen: string;
  last_confirmed: string;
  possibly_stale: boolean;
};

export type ProjectMemory = {
  project_id: string;
  name: string;
  learned_signatures: LearnedSignature[];
  deploy_cadence: string | null;
  known_flaky: Array<{ pattern: string; note?: string }>;
  glossary: Array<{ term: string; means: string }>;
  summary: string;
};

/**
 * What Selvedge has learned about ONE project, in plain English. The moat made
 * visible: graduated error meanings it has actually seen on this project (with
 * when it learned them and whether they've gone quiet), the deploy rhythm it
 * picked up, the flaky-but-fine checks it recognizes, and the owner's own
 * glossary. This is what a user would lose by leaving.
 */
export async function projectMemory(db: Db, orgId: string, projectId: string, now: Date = new Date()): Promise<ProjectMemory | null> {
  const [row] = await db.select().from(packs).where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId))).limit(1);
  if (!row) return null;
  const pack = row.pack as ContextPack;

  const rows = await db
    .select({ eventType: narrations.eventType, meta: narrations.meta, createdAt: narrations.createdAt })
    .from(narrations)
    .where(and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId)));

  type Agg = { eventType: string; count: number; first: Date; last: Date };
  const byFingerprint = new Map<string, Agg>();
  for (const r of rows) {
    const fp = (r.meta as { fingerprint?: string } | null)?.fingerprint;
    if (!fp) continue;
    const created = r.createdAt as Date;
    const existing = byFingerprint.get(fp);
    if (existing) {
      existing.count++;
      if (created < existing.first) existing.first = created;
      if (created > existing.last) existing.last = created;
    } else {
      byFingerprint.set(fp, { eventType: r.eventType, count: 1, first: created, last: created });
    }
  }

  const fingerprints = [...byFingerprint.keys()];
  const libRows = fingerprints.length
    ? await db.select().from(narrationLibrary).where(inArray(narrationLibrary.fingerprint, fingerprints))
    : [];
  const graduated = new Map(libRows.filter((l) => l.status === 'graduated').map((l) => [l.fingerprint, l]));

  const learned: LearnedSignature[] = [];
  for (const [fp, agg] of byFingerprint) {
    const lib = graduated.get(fp);
    if (!lib) continue; // only truly-learned (graduated) meanings count as memory
    const phrasing = lib.phrasing as NarrationOutput;
    learned.push({
      event_type: agg.eventType,
      plain: phrasing.fragment.replaceAll('{project}', pack.identity.name),
      times_seen: agg.count,
      first_seen: agg.first.toISOString(),
      last_confirmed: agg.last.toISOString(),
      possibly_stale: now.getTime() - agg.last.getTime() > STALE_AFTER_MS,
    });
  }
  learned.sort((a, b) => b.times_seen - a.times_seen);

  const knownFlaky = (pack.baselines?.known_flaky ?? [])
    .filter((k) => k.graduated)
    .map((k) => ({ pattern: k.pattern, ...(k.note ? { note: k.note } : {}) }));
  const glossary = (pack.voice.glossary_overrides ?? []).map((g) => ({ term: g.term, means: g.preferred_phrasing }));

  return {
    project_id: projectId,
    name: pack.identity.name,
    learned_signatures: learned,
    deploy_cadence: pack.baselines?.deploy_cadence ?? null,
    known_flaky: knownFlaky,
    glossary,
    summary: projectSummary(pack.identity.name, learned.length, pack.baselines?.deploy_cadence ?? null, knownFlaky.length),
  };
}

function projectSummary(name: string, learnedCount: number, cadence: string | null, flakyCount: number): string {
  const parts: string[] = [];
  parts.push(learnedCount > 0 ? `I've learned ${learnedCount} of ${name}'s error type${learnedCount === 1 ? '' : 's'}` : `I'm still learning ${name}'s error types`);
  if (cadence) parts.push(`know its deploy rhythm (${cadence.replace('_', ' ')})`);
  if (flakyCount > 0) parts.push(`recognize ${flakyCount} check${flakyCount === 1 ? '' : 's'} that are flaky-but-fine`);
  return `${parts.join(', ')}.`;
}

export type StackMemory = {
  apps: number;
  watching_since: string | null;
  watched_days: number;
  things_learned: number;
  summary: string;
};

/**
 * The stack-level roll-up: a single, growing number that IS the switching cost,
 * made legible. "Selvedge has watched your 9 apps for 38 days and learned 120
 * things about how they behave."
 */
export async function stackMemory(db: Db, orgId: string, now: Date = new Date()): Promise<StackMemory> {
  const packRows = await db.select().from(packs).where(eq(packs.orgId, orgId));
  const apps = packRows.length;

  let earliest: Date | null = null;
  for (const r of packRows) {
    const c = r.createdAt as Date;
    if (!earliest || c < earliest) earliest = c;
  }
  const watchedDays = earliest ? Math.max(0, Math.floor((now.getTime() - earliest.getTime()) / DAY_MS)) : 0;

  // Distinct graduated meanings this org has actually seen…
  const narrRows = await db.select({ meta: narrations.meta }).from(narrations).where(eq(narrations.orgId, orgId));
  const fps = new Set<string>();
  for (const r of narrRows) {
    const fp = (r.meta as { fingerprint?: string } | null)?.fingerprint;
    if (fp) fps.add(fp);
  }
  const fpList = [...fps];
  const libRows = fpList.length ? await db.select().from(narrationLibrary).where(inArray(narrationLibrary.fingerprint, fpList)) : [];
  const graduatedSeen = libRows.filter((l) => l.status === 'graduated').length;

  // …plus the per-pack learned facts (cadence, flaky sets, glossary).
  let packLearned = 0;
  for (const r of packRows) {
    const p = r.pack as ContextPack;
    if (p.baselines?.deploy_cadence) packLearned++;
    packLearned += (p.baselines?.known_flaky ?? []).filter((k) => k.graduated).length;
    packLearned += (p.voice.glossary_overrides ?? []).length;
  }

  const thingsLearned = graduatedSeen + packLearned;
  return {
    apps,
    watching_since: earliest?.toISOString() ?? null,
    watched_days: watchedDays,
    things_learned: thingsLearned,
    summary:
      apps === 0
        ? 'Nothing connected yet — the memory starts the day you add your first app.'
        : `Selvedge has watched your ${apps} app${apps === 1 ? '' : 's'} for ${watchedDays} day${watchedDays === 1 ? '' : 's'} and learned ${thingsLearned} thing${thingsLearned === 1 ? '' : 's'} about how they behave.`,
  };
}
