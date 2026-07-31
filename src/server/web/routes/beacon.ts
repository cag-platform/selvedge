import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { issueBeacon, beaconStatus, revokeBeacon } from '../../connectors/errors/beaconStore.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The owner-facing side of the error beacon: mint the token, see whether one is
 * issued and when it last reported, revoke it. The token is returned exactly
 * once, on issue — thereafter only its status is visible, never the token.
 * Every route confirms the project belongs to this org first (a missing pack is
 * a 404), so one org can never mint or revoke a beacon on another's project.
 */
export function createBeaconRouter(db: Db) {
  const router = Router();

  async function requireProject(req: Request): Promise<string | null> {
    const projectId = req.params.projectId ?? '';
    const pack = await getPack(db, orgIdOf(req), projectId);
    return pack ? projectId : null;
  }

  router.post(
    '/api/projects/:projectId/beacon',
    asyncHandler(async (req, res) => {
      const projectId = await requireProject(req);
      if (!projectId) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      // Shown once. Re-issuing rotates and invalidates the previous token.
      const token = await issueBeacon(db, orgIdOf(req), projectId);
      res.json({ token, note: 'Copy this now — it is shown only once.' });
    }),
  );

  router.get(
    '/api/projects/:projectId/beacon',
    asyncHandler(async (req, res) => {
      const projectId = await requireProject(req);
      if (!projectId) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      res.json(await beaconStatus(db, orgIdOf(req), projectId));
    }),
  );

  router.delete(
    '/api/projects/:projectId/beacon',
    asyncHandler(async (req, res) => {
      const projectId = await requireProject(req);
      if (!projectId) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const revoked = await revokeBeacon(db, orgIdOf(req), projectId);
      res.json({ revoked });
    }),
  );

  return router;
}
