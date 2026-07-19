import { Router, type Request } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { digests, llmUsage, narrations } from '../../db/schema/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** The dogfood budget line (acceptance gate 5): flag, don't block, when a day lands over. */
export const DAILY_BUDGET_USD = 0.15;

/**
 * Admin metrics (gates 2 and 5): per-day cost with the budget line,
 * lib_hit_rate next to it, fallback counts, and the before/after digest
 * pairs (mechanical vs composed) for the replay view.
 */
export function createAdminRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/admin/metrics',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);

      const costRows = await db
        .select({
          day: sql<string>`to_char(${llmUsage.createdAt}, 'YYYY-MM-DD')`,
          costUsd: sql<number>`sum(${llmUsage.costUsd})`,
          calls: sql<number>`count(*)`,
          failures: sql<number>`count(*) filter (where ${llmUsage.ok} <> 'true')`,
        })
        .from(llmUsage)
        .where(eq(llmUsage.orgId, orgId))
        .groupBy(sql`to_char(${llmUsage.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${llmUsage.createdAt}, 'YYYY-MM-DD') desc`);

      const libRows = await db
        .select({
          day: sql<string>`to_char(${narrations.createdAt}, 'YYYY-MM-DD')`,
          libRouted: sql<number>`count(*)`,
          libHits: sql<number>`count(*) filter (where (${narrations.meta} ->> 'lib_hit') = 'true')`,
        })
        .from(narrations)
        .where(and(eq(narrations.orgId, orgId), eq(narrations.intendedPath, 'LIB')))
        .groupBy(sql`to_char(${narrations.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${narrations.createdAt}, 'YYYY-MM-DD') desc`);

      const [fallbacks] = await db
        .select({
          count: sql<number>`count(*) filter (where (${narrations.meta} ->> 'fallback_reason') is not null)`,
          needsReview: sql<number>`count(*) filter (where (${narrations.meta} ->> 'needs_review') = 'true')`,
        })
        .from(narrations)
        .where(eq(narrations.orgId, orgId));

      res.json({
        budget_usd_per_day: DAILY_BUDGET_USD,
        cost_by_day: costRows.map((r) => ({
          day: r.day,
          cost_usd: Number(r.costUsd),
          calls: Number(r.calls),
          failed_calls: Number(r.failures),
          over_budget: Number(r.costUsd) > DAILY_BUDGET_USD,
        })),
        lib_hit_rate_by_day: libRows.map((r) => ({
          day: r.day,
          lib_routed: Number(r.libRouted),
          lib_hits: Number(r.libHits),
          hit_rate: Number(r.libRouted) === 0 ? 0 : Number(r.libHits) / Number(r.libRouted),
        })),
        template_fallbacks_total: Number(fallbacks?.count ?? 0),
        fragments_needing_review: Number(fallbacks?.needsReview ?? 0),
      });
    }),
  );

  // Before/after (gate 2): every digest row carries both renderings.
  router.get(
    '/api/admin/digests',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const rows = await db
        .select()
        .from(digests)
        .where(eq(digests.orgId, orgId))
        .orderBy(desc(digests.digestDate))
        .limit(14);
      res.json(
        rows.map((r) => ({
          digest_date: r.digestDate,
          voice: r.voice,
          composed_text: r.voice === 'composed' ? r.renderedText : null,
          mechanical_text: r.mechanicalText ?? (r.voice === 'mechanical' || r.voice === 'fallback' ? r.renderedText : null),
        })),
      );
    }),
  );

  return router;
}
