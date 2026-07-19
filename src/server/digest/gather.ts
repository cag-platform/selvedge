import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrations, digests } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import type { ContextPack } from '../../shared/types/pack.js';

export type GatheredNarration = typeof narrations.$inferSelect;

export async function gatherWindowNarrations(db: Db, orgId: string, start: Date, end: Date): Promise<GatheredNarration[]> {
  return db
    .select()
    .from(narrations)
    .where(
      and(
        eq(narrations.orgId, orgId),
        gte(narrations.occurredAt, start),
        lt(narrations.occurredAt, end),
        inArray(narrations.delivery, ['DIGEST', 'PUSH']),
      ),
    );
}

export async function gatherPacks(db: Db, orgId: string): Promise<ContextPack[]> {
  return listPacks(db, orgId);
}

export async function getPreviousDigest(db: Db, orgId: string, dateString: string) {
  const [row] = await db
    .select()
    .from(digests)
    .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, dateString)))
    .limit(1);
  return row ?? null;
}
