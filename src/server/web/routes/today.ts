import { Router, type Request } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { digests, narrations, orgs } from '../../db/schema/index.js';
import { localDateString } from '../../digest/timezone.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Today page (deliverable 8): today's digest + any narration since it was composed. */
export function createTodayRouter(db: Db) {
  const router = Router();

  router.get('/api/today', async (req, res) => {
    const orgId = orgIdOf(req);
    const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
    const todayStr = localDateString(new Date(), org?.timezone ?? 'UTC');

    const [digest] = await db
      .select()
      .from(digests)
      .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, todayStr)))
      .limit(1);

    const postDigestEvents = digest
      ? await db
          .select()
          .from(narrations)
          .where(and(eq(narrations.orgId, orgId), gt(narrations.createdAt, digest.createdAt)))
      : [];

    res.json({ digest: digest ?? null, post_digest_events: postDigestEvents });
  });

  return router;
}
