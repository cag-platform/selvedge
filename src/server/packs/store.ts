import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { packs, events, narrations } from '../db/schema/index.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { assertValidPack } from './validate.js';
import { applyHumanPatch, applyMachinePatch, type HumanPatch, type MachinePatch } from './ownership.js';

export async function getPack(db: Db, orgId: string, projectId: string): Promise<ContextPack | null> {
  const [row] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)))
    .limit(1);
  return row ? (row.pack as ContextPack) : null;
}

export async function listPacks(db: Db, orgId: string): Promise<ContextPack[]> {
  const rows = await db.select().from(packs).where(eq(packs.orgId, orgId));
  return rows.map((r) => r.pack as ContextPack);
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
 * Deletes a project outright: the pack and everything scoped to it — its
 * narrations (the project's Today-page cards) and its events (the raw log
 * that fed them). Done in one transaction so a project never half-exists.
 * Org-level data (digests, connector_health) is untouched. Returns false if
 * there was no such pack (the route maps that to a 404).
 */
export async function deletePack(db: Db, orgId: string, projectId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ projectId: packs.projectId })
      .from(packs)
      .where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)))
      .limit(1);
    if (!existing) return false;

    await tx.delete(narrations).where(and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId)));
    await tx.delete(events).where(and(eq(events.orgId, orgId), eq(events.projectId, projectId)));
    await tx.delete(packs).where(and(eq(packs.orgId, orgId), eq(packs.projectId, projectId)));
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
