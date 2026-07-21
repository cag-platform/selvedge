import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { listPacks, mutedProjectIds } from '../../packs/store.js';
import { edgeStatus, healthLine } from '../../packs/healthLine.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Projects list (deliverable 8): pack cards with name, plain health line, links out. */
export function createProjectsRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/projects',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      // Archived (permanently deleted) projects are excluded by default; muted
      // ones are included but flagged so the client can collapse them.
      const [packs, muted] = await Promise.all([listPacks(db, orgId), mutedProjectIds(db, orgId)]);
      res.json(
        packs.map((pack) => ({
          project_id: pack.identity.project_id,
          name: pack.identity.name,
          tier: pack.stakes.tier,
          health_line: healthLine(pack),
          edge: edgeStatus(pack),
          links: pack.identity.links ?? {},
          muted: muted.has(pack.identity.project_id),
        })),
      );
    }),
  );

  return router;
}
