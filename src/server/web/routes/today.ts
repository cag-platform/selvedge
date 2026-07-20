import { Router, type Request } from 'express';
import { and, eq, gt, gte } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { digests, narrations, orgs } from '../../db/schema/index.js';
import { localDateString, yesterdayBoundsUtc } from '../../digest/timezone.js';
import { composeDigestForOrg } from '../../digest/compose.js';
import type { ComposeLlmDeps } from '../../digest/composeLlm.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Today page (deliverable 8): today's digest + any narration since it was composed. */
export function createTodayRouter(db: Db, llmDeps?: ComposeLlmDeps) {
  const router = Router();

  // On-demand composition — same idempotent path the 7:00 cron takes, so
  // pressing it twice (or the cron firing later) never double-writes a day.
  router.post(
    '/api/today/compose',
    asyncHandler(async (req, res) => {
      const digest = await composeDigestForOrg(db, orgIdOf(req), new Date(), llmDeps);
      res.json({ digest });
    }),
  );

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

      // Enrich attention items with their narration's verdict + technical
      // line so the client can draw the edge (verdict -> status is fixed
      // vocabulary) and offer the mono register without a second request.
      let enriched = digest ?? null;
      if (digest) {
        const sections = digest.sections as { attention?: Array<{ narration_id: string }> };
        const ids = (sections.attention ?? []).map((a) => a.narration_id);
        if (ids.length > 0) {
          const rows = (await db.select().from(narrations).where(eq(narrations.orgId, orgId))).filter((n) => ids.includes(n.id));
          const byId = new Map(rows.map((n) => [n.id, n]));
          enriched = {
            ...digest,
            sections: {
              ...(digest.sections as Record<string, unknown>),
              attention: (sections.attention ?? []).map((a) => ({
                ...a,
                verdict: byId.get(a.narration_id)?.verdict ?? null,
                technical_detail: byId.get(a.narration_id)?.technicalDetail ?? null,
                event_id: byId.get(a.narration_id)?.eventId ?? null,
              })),
            },
          };
        }
      }

      res.json({ digest: enriched, post_digest_events: postDigestEvents });
    }),
  );

  return router;
}
