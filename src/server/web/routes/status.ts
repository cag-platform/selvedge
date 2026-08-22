import { Router, type Request } from 'express';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { narrations, orgs, trustIncidents } from '../../db/schema/index.js';
import { yesterdayBoundsUtc } from '../../digest/timezone.js';
import { getPack } from '../../packs/store.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * STATUS — what has happened, on the projects it happened to.
 *
 * This is what is left of the daily brief once the brief itself stops being
 * the front door. The brief asked the owner to come and read a composed note
 * every morning; the work is in the workbench, and status belongs beside the
 * projects it describes rather than on a page of its own.
 *
 * Two things live here, and neither is decoration:
 *
 * CORRECTIONS. When Selvedge said something was fine and it wasn't, it says
 * so out loud. Reading them here ACKNOWLEDGES them — which is exactly why
 * this endpoint, and not the retired brief, must be the one place that does
 * it. A correction acknowledged by a page nobody opens is a correction nobody
 * ever saw, which is the failure the rule exists to prevent.
 *
 * LIVE EVENTS since local midnight, rendered in each project's own voice.
 */
export function createStatusRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/status',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const now = new Date();
      const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
      const timezone = org?.timezone ?? 'UTC';
      const since = yesterdayBoundsUtc(timezone, now).end;

      const rows = await db
        .select()
        .from(narrations)
        .where(and(eq(narrations.orgId, orgId), gte(narrations.createdAt, since)));

      // The card's register — how much technical detail rides along — is the
      // project's own voice.detail_level, the same rule the brief obeyed.
      // Resolved once per distinct project so a plain_only owner never sees
      // the mono line and a technical_forward one sees it inline.
      const projectIds = [...new Set(rows.map((n) => n.projectId).filter((id): id is string => Boolean(id)))];
      const packByProject = new Map(
        await Promise.all(projectIds.map(async (pid) => [pid, await getPack(db, orgId, pid)] as const)),
      );
      const live = rows.map((n) => {
        const pack = n.projectId ? packByProject.get(n.projectId) : null;
        return {
          ...n,
          // Something with no project yet falls back to the expandable middle
          // register — never plain_only, so its "why" is at least reachable.
          detail_level: pack?.voice.detail_level ?? 'plain_expandable',
          project_name: pack?.identity.name ?? null,
          correlation: (n.meta as { correlation?: unknown } | null)?.correlation ?? null,
        };
      });

      const openIncidents = await db
        .select()
        .from(trustIncidents)
        .where(and(eq(trustIncidents.orgId, orgId), eq(trustIncidents.acknowledged, false)));
      const corrections = openIncidents.map((i) => ({
        id: i.id,
        project_id: i.projectId,
        line: i.detail ?? "Earlier I said this was fine — it wasn't.",
      }));
      if (openIncidents.length > 0) {
        await db
          .update(trustIncidents)
          .set({ acknowledged: true })
          .where(
            inArray(
              trustIncidents.id,
              openIncidents.map((i) => i.id),
            ),
          );
      }

      res.json({ corrections, live });
    }),
  );

  return router;
}
