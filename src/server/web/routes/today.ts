import { Router, type Request } from 'express';
import { and, eq, gt, gte } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { digests, narrations, orgs } from '../../db/schema/index.js';
import { localDateString, yesterdayBoundsUtc } from '../../digest/timezone.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Today page (deliverable 8): today's digest + any narration since it was composed. */
export function createTodayRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/today',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const now = new Date();
      const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
      const timezone = org?.timezone ?? 'UTC';
      const todayStr = localDateString(now, timezone);

      const [digest] = await db
        .select()
        .from(digests)
        .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, todayStr)))
        .limit(1);

      // Before the first digest of the day composes (e.g. very first day, or
      // simply before 7am local), still surface anything that's happened
      // since local midnight — a connector going auth_failed shouldn't wait
      // for a digest to exist before it's visible (acceptance gate 6).
      const since = digest ? digest.createdAt : yesterdayBoundsUtc(timezone, now).end;
      const postDigestEvents = await db
        .select()
        .from(narrations)
        .where(and(eq(narrations.orgId, orgId), digest ? gt(narrations.createdAt, since) : gte(narrations.createdAt, since)));

      res.json({ digest: digest ?? null, post_digest_events: postDigestEvents });
    }),
  );

  return router;
}
