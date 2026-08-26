import { and, asc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { generatedVisuals } from '../db/schema/index.js';

export type NewVisual = {
  threadId: string;
  consultationId?: string;
  directingAgent: string;
  renderingProvider: string;
  renderingModel: string;
  request: string;
  parentId?: string;
};

export async function queueVisual(db: Db, orgId: string, input: NewVisual) {
  const [row] = await db.insert(generatedVisuals).values({ id: ulid(), orgId, ...input }).returning();
  return row!;
}

export async function completeVisual(db: Db, orgId: string, id: string, result: {
  messageId?: string; renderPrompt: string; storageKey: string; mime: string; width: number; height: number; bytes: number;
  directionMs?: number; renderMs?: number; storageMs?: number;
}) {
  const [row] = await db.update(generatedVisuals).set({ ...result, status: 'ready', error: null, updatedAt: new Date() })
    .where(and(eq(generatedVisuals.orgId, orgId), eq(generatedVisuals.id, id))).returning();
  return row ?? null;
}

export async function failVisual(db: Db, orgId: string, id: string, error: string) {
  const [row] = await db.update(generatedVisuals).set({ status: 'failed', error, updatedAt: new Date() })
    .where(and(eq(generatedVisuals.orgId, orgId), eq(generatedVisuals.id, id))).returning();
  return row ?? null;
}

export function visualsForThread(db: Db, orgId: string, threadId: string) {
  return db.select().from(generatedVisuals)
    .where(and(eq(generatedVisuals.orgId, orgId), eq(generatedVisuals.threadId, threadId)))
    .orderBy(asc(generatedVisuals.createdAt));
}

export async function visualById(db: Db, orgId: string, id: string) {
  const [row] = await db.select().from(generatedVisuals)
    .where(and(eq(generatedVisuals.orgId, orgId), eq(generatedVisuals.id, id))).limit(1);
  return row ?? null;
}
