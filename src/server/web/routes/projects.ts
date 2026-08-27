import { Router, type Request } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectBuild } from '../../db/schema/index.js';
import { listPacks, mutedProjectIds } from '../../packs/store.js';
import { edgeStatus, hasHealthSignal, healthLine } from '../../packs/healthLine.js';
import { consoleLinks } from '../../connectors/consoles.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { claimUrl, createTransferRequest, NeonClaimError } from '../../connectors/neon/claim.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Projects list (deliverable 8): pack cards with name, plain health line, links out. */
export type ProjectsDeps = {
  /** Injected in tests — the real one talks to Neon with the platform key. */
  createTransfer?: typeof createTransferRequest;
};

export function createProjectsRouter(db: Db, deps: ProjectsDeps = {}) {
  const router = Router();
  const createTransfer = deps.createTransfer ?? createTransferRequest;

  router.get(
    '/api/projects',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      // Archived (permanently deleted) projects are excluded by default; muted
      // ones are included but flagged so the client can collapse them.
      const [packs, muted, buildRows] = await Promise.all([
        listPacks(db, orgId),
        mutedProjectIds(db, orgId),
        db.select({ projectId: projectBuild.projectId, stagedChangesReady: projectBuild.stagedChangesReady }).from(projectBuild).where(eq(projectBuild.orgId, orgId)),
      ]);
      const buildByProject = new Map(buildRows.map((row) => [row.projectId, row]));
      res.json(
        packs.map((pack) => ({
          project_id: pack.identity.project_id,
          name: pack.identity.name,
          tier: pack.stakes.tier,
          // Null where nothing has reported — see hasHealthSignal.
          health_line: hasHealthSignal(pack) ? healthLine(pack) : null,
          edge: hasHealthSignal(pack) ? edgeStatus(pack) : null,
          review_ready: buildByProject.get(pack.identity.project_id)?.stagedChangesReady ?? false,
          online: Boolean(pack.identity.links?.live_url),
          links: pack.identity.links ?? {},
          // The doors to the accounts behind it — see connectors/consoles.ts.
          console_links: consoleLinks(pack),
          muted: muted.has(pack.identity.project_id),
        })),
      );
    }),
  );

  /**
   * MAKE THE DATABASE THEIRS. Provisioned databases live on Selvedge's Neon
   * account — the convenience of zero-signup go-live, at the cost of custody.
   * This mints Neon's own transfer request and hands back the claim URL; the
   * ACCEPT happens in the owner's browser with their own Neon session, and
   * connection strings do not change, so the running app never notices.
   * See connectors/neon/claim.ts.
   */
  router.post(
    '/api/projects/:projectId/database/claim',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const neon = pack.topology.sources.find((s) => s.connector === 'neon');
      if (!neon) {
        res.status(409).json({ error: 'this project has no Selvedge-provisioned database to claim.' });
        return;
      }
      try {
        const transfer = await createTransfer(neon.resource_id);
        res.json({
          claim_url: claimUrl(neon.resource_id, transfer.id),
          expires_at: transfer.expiresAt,
          note: 'Open it, sign in to your own Neon account, and the database moves — connection strings stay the same, so the app keeps running.',
        });
      } catch (err) {
        if (err instanceof NeonClaimError) {
          res.status(502).json({ error: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}
