import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { gatherProtectionBrief } from '../../brief/gatherProtection.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The protection brief for a connected app — the Phase 1 connect-time
 * deliverable. Returns the structured brief; the client renders it at three
 * detail levels (the headline and coverage lines are plain; the raw coverage
 * flags are the technical register).
 */
export function createProtectionRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/projects/:projectId/protection-brief',
    asyncHandler(async (req, res) => {
      const brief = await gatherProtectionBrief(db, orgIdOf(req), req.params.projectId ?? '');
      if (!brief) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      res.json({ brief });
    }),
  );

  return router;
}
