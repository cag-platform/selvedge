import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { getPack, listPacks, updateHumanSections } from '../../packs/store.js';
import { PackValidationError } from '../../packs/validate.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export function createPacksRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/packs',
    asyncHandler(async (req, res) => {
      res.json(await listPacks(db, orgIdOf(req)));
    }),
  );

  router.get(
    '/api/packs/:projectId',
    asyncHandler(async (req, res) => {
      const pack = await getPack(db, orgIdOf(req), req.params.projectId!);
      if (!pack) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(pack);
    }),
  );

  // Human-owned sections only (identity/stakes/voice/topology minus the
  // machine role of sources) — connector-driven updates never go through
  // this HTTP surface, only through updateMachineSections() in-process.
  router.patch(
    '/api/packs/:projectId',
    asyncHandler(async (req, res) => {
      try {
        const updated = await updateHumanSections(db, orgIdOf(req), req.params.projectId!, req.body);
        res.json(updated);
      } catch (err) {
        if (err instanceof PackValidationError) {
          res.status(422).json({ error: err.message, details: err.errors });
          return;
        }
        if (err instanceof Error && err.message.startsWith('No pack')) {
          res.status(404).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}
