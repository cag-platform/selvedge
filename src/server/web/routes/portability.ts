import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { exportBundle, importBundle, type ExportBundle } from '../../memory/portability.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Portability (Ironclad 1, part C): export your full context, re-import it. */
export function createPortabilityRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/export',
    asyncHandler(async (req, res) => {
      const bundle = await exportBundle(db, orgIdOf(req));
      res.setHeader('Content-Disposition', 'attachment; filename="selvedge-context.json"');
      res.json(bundle);
    }),
  );

  router.post(
    '/api/import',
    asyncHandler(async (req, res) => {
      const bundle = req.body as ExportBundle;
      if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.packs)) {
        res.status(400).json({ error: 'body must be a Selvedge export bundle with a packs array' });
        return;
      }
      try {
        const result = await importBundle(db, orgIdOf(req), bundle);
        res.json(result);
      } catch (err) {
        res.status(422).json({ error: err instanceof Error ? err.message : 'import failed' });
      }
    }),
  );

  return router;
}
