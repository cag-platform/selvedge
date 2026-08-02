import { and, asc, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { sketches, sketchMessages } from '../db/schema/index.js';

/**
 * The only writer of the sketch tables. Every read and write is scoped by
 * (orgId, …) — the tenancy contract holds here exactly as it does for cards
 * and packs, and a sketch is never reachable from another tenant.
 */

export type SketchRow = typeof sketches.$inferSelect;
export type SketchMessageRow = typeof sketchMessages.$inferSelect;

/** A title is what the list shows — the first thing said, kept short. */
export function titleFrom(text: string): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59).trimEnd()}…`;
}

export async function createSketch(db: Db, orgId: string, title: string, projectId: string | null): Promise<SketchRow> {
  const [row] = await db
    .insert(sketches)
    .values({ id: ulid(), orgId, projectId, title })
    .returning();
  return row!;
}

export async function getSketch(db: Db, orgId: string, sketchId: string): Promise<SketchRow | null> {
  const [row] = await db
    .select()
    .from(sketches)
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)))
    .limit(1);
  return row ?? null;
}

/** Most recently touched first — the one you were just thinking about is the one you want. */
export async function listSketches(db: Db, orgId: string): Promise<SketchRow[]> {
  return db.select().from(sketches).where(eq(sketches.orgId, orgId)).orderBy(desc(sketches.updatedAt));
}

export async function listMessages(db: Db, orgId: string, sketchId: string): Promise<SketchMessageRow[]> {
  return db
    .select()
    .from(sketchMessages)
    .where(and(eq(sketchMessages.orgId, orgId), eq(sketchMessages.sketchId, sketchId)))
    .orderBy(asc(sketchMessages.createdAt));
}

export async function addMessage(
  db: Db,
  orgId: string,
  sketchId: string,
  role: 'owner' | 'sketch',
  content: string,
): Promise<SketchMessageRow> {
  const [row] = await db
    .insert(sketchMessages)
    .values({ id: ulid(), orgId, sketchId, role, content })
    .returning();
  // Any message makes this the freshest sketch, so the list order stays useful.
  await db
    .update(sketches)
    .set({ updatedAt: new Date() })
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)));
  return row!;
}

/**
 * Record the brief when the idea is clear. Passing null clears it — a follow-up
 * that reopens a settled question should not leave a stale brief sitting there
 * looking ready to build.
 */
export async function setBrief(db: Db, orgId: string, sketchId: string, brief: string | null): Promise<void> {
  await db
    .update(sketches)
    .set({ brief, updatedAt: new Date() })
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)));
}

/** Attach a project once the idea has a home (or the owner picks one at handoff). */
export async function setProject(db: Db, orgId: string, sketchId: string, projectId: string): Promise<void> {
  await db
    .update(sketches)
    .set({ projectId, updatedAt: new Date() })
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)));
}

export async function markHandedOff(db: Db, orgId: string, sketchId: string): Promise<void> {
  await db
    .update(sketches)
    .set({ handedOffAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)));
}

export async function deleteSketch(db: Db, orgId: string, sketchId: string): Promise<boolean> {
  await db.delete(sketchMessages).where(and(eq(sketchMessages.orgId, orgId), eq(sketchMessages.sketchId, sketchId)));
  const deleted = await db
    .delete(sketches)
    .where(and(eq(sketches.orgId, orgId), eq(sketches.id, sketchId)))
    .returning({ id: sketches.id });
  return deleted.length > 0;
}
