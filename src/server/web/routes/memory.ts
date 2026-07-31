import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { projectMemory, stackMemory } from '../../memory/learned.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * "What Selvedge has learned" (Ironclad 1). The moat made visible: the
 * compounding per-app memory surfaced in plain English so the user feels the
 * switching cost deepening, rather than it working silently in the background.
 */
export function createMemoryRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/memory',
    asyncHandler(async (req, res) => {
      res.json(await stackMemory(db, orgIdOf(req)));
    }),
  );

  router.get(
    '/api/projects/:projectId/memory',
    asyncHandler(async (req, res) => {
      const memory = await projectMemory(db, orgIdOf(req), req.params.projectId!);
      if (!memory) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(memory);
    }),
  );

  return router;
}
