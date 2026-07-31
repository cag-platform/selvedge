import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { packs, events, narrations } from '../db/schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { assertValidPack } from './validate.js';
import { applyHumanPatch, applyMachinePatch, type HumanPatch, type MachinePatch } from './ownership.js';

/**
 * Read options for pack listings:
 * - `includeArchived` — archived packs are permanent-delete tombstones; every
 *   user surface excludes them, but resolveProjectId must include them so the
 *   GitHub backfill treats a deleted repo as spoken-for and won't resurrect it.
 * - `includeMuted` — muted packs stay visible (they still list) but drop out of
 *   the daily digest, so the digest gather passes `includeMuted: false`.
 */
export type ListPacksOptions = { includeArchived?: boolean; includeMuted?: boolean };

export async function getPack(
  db: Db,
  orgId: string,
  projectId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ContextPack | null> {
  const [row] = await db
    .select()
    .from(packs)
    .where(
      and(
        eq(packs.orgId, orgId),
        eq(packs.projectId, projectId),
        includeArchived ? undefined : isNull(packs.archivedAt),
      ),
    )
    .limit(1);
  return row ? (row.pack as ContextPack) : null;
}

export async function listPacks(
  db: Db,
  orgId: string,
  { includeArchived = false, includeMuted = true }: ListPacksOptions = {},
): Promise<ContextPack[]> {
  const rows = await db
    .select()
    .from(packs)
    .where(
      and(
        eq(packs.orgId, orgId),
        includeArchived ? undefined : isNull(packs.archivedAt),
        includeMuted ? undefined : isNull(packs.mutedAt),
      ),
    );
  return rows.map((r) => r.pack as ContextPack);
}

/** Project ids the org has permanently deleted (archived tombstones). The
 *  GitHub backfill checks this to leave a deleted repo dormant instead of
 *  re-populating it. */
export async function archivedProjectIds(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ projectId: packs.projectId })
    .from(packs)
    .where(and(eq(packs.orgId, orgId), isNotNull(packs.archivedAt)));
  return new Set(rows.map((r) => r.projectId));
}

/** Project ids the org has muted — used to flag cards without changing the
 *  pack JSON shape every other caller depends on. Excludes archived. */
export async function mutedProjectIds(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ projectId: packs.projectId })
    .from(packs)
    .where(and(eq(packs.orgId, orgId), isNull(packs.archivedAt), isNotNull(packs.mutedAt)));
  return new Set(rows.map((r) => r.projectId));
}

/** Set or clear a project's muted state. Returns false if there's no such
 *  (non-archived) pack. */
export async function setPackMuted(db: Db, orgId: string, projectId: string, muted: boolean): Promise<boolean> {
  const existing = await getPack(db, orgId, projectId);
  if (!existing) return false;
  await db
    .update(packs)
    .set({ mutedAt: muted ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)));
  return true;
}

/** Full-pack create, used by onboarding and the worked-examples seed script. */
export async function createPack(db: Db, orgId: string, pack: ContextPack): Promise<ContextPack> {
  assertValidPack(pack);
  await db.insert(packs).values({ orgId, projectId: pack.identity.project_id, pack });
  return pack;
}

async function requirePack(db: Db, orgId: string, projectId: string): Promise<ContextPack> {
  const existing = await getPack(db, orgId, projectId);
  if (!existing) throw new Error(`No pack for org "${orgId}" project "${projectId}"`);
  return existing;
}

/**
 * Permanently deletes a project from the owner's point of view: purges its
 * narrations (the project's Today-page cards) and its events (the raw log that
 * fed them), then *archives* the pack row rather than dropping it. The row is
 * kept as a tombstone because a project auto-created from a GitHub repo can't
 * be truly row-deleted — the next installation sync would call resolveProjectId,
 * find no pack, and re-scaffold it. Keeping an archived row means
 * resolveProjectId still maps the repo (so backfill skips it) while every user
 * surface filters it out (getPack/listPacks exclude archived by default).
 * Done in one transaction so a project never half-exists. Org-level data
 * (digests, connector_health) is untouched. Returns false if there was no such
 * live pack — including one already archived (the route maps that to a 404).
 */
export async function deletePack(db: Db, orgId: string, projectId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ projectId: packs.projectId })
      .from(packs)
      .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId), isNull(packs.archivedAt)))
      .limit(1);
    if (!existing) return false;

    await tx.delete(narrations).where(and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId)));
    await tx.delete(events).where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)));
    await tx
      .update(packs)
      .set({ archivedAt: new Date(), mutedAt: null, updatedAt: new Date() })
      .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)));
    return true;
  });
}

/** Identity/stakes/voice/topology(minus sources' machine role)/capability_gaps — user-authenticated only. */
export async function updateHumanSections(db: Db, orgId: string, projectId: string, patch: HumanPatch): Promise<ContextPack> {
  const existing = await requirePack(db, orgId, projectId);
  const next = applyHumanPatch(existing, patch);
  assertValidPack(next);
  await db
    .update(packs)
    .set({ pack: next, updatedAt: new Date() })
    .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)));
  return next;
}

/** topology.sources (additive)/baselines/state/trust — connector-driven only. */
export async function updateMachineSections(db: Db, orgId: string, projectId: string, patch: MachinePatch): Promise<ContextPack> {
  const existing = await requirePack(db, orgId, projectId);
  const next = applyMachinePatch(existing, patch);
  assertValidPack(next);
  await db
    .update(packs)
    .set({ pack: next, updatedAt: new Date() })
    .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)));
  return next;
}
