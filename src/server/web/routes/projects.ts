import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { listPacks } from '../../packs/store.js';
import { healthLine } from '../../packs/healthLine.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Projects list (deliverable 8): pack cards with name, plain health line, links out. */
export function createProjectsRouter(db: Db) {
  const router = Router();

  router.get('/api/projects', async (req, res) => {
    const packs = await listPacks(db, orgIdOf(req));
    res.json(
      packs.map((pack) => ({
        project_id: pack.identity.project_id,
        name: pack.identity.name,
        tier: pack.stakes.tier,
        health_line: healthLine(pack),
        links: pack.identity.links ?? {},
      })),
    );
  });

  return router;
}
