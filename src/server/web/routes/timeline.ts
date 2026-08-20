import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getPack } from '../../packs/store.js';
import { projectTimeline, searchProject } from '../../timeline/store.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The record, made visible: one project's history, and search inside it.
 *
 * Both are read-only projections of data the owner already has — nothing here
 * writes, and nothing here composes with a model. The window defaults to a
 * fortnight because that is the question people actually ask ("what happened to
 * this in the last two weeks?"), and `days=0` means everything.
 */
const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

export function createTimelineRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/projects/:projectId/timeline',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const raw = Number(req.query.days);
      const days = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, MAX_DAYS) : DEFAULT_DAYS;
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;

      const entries = await projectTimeline(db, orgId, projectId, { ...(since ? { since } : {}) });
      res.json({
        project: { id: projectId, name: pack.identity.name },
        days,
        entries,
      });
    }),
  );

  router.get(
    '/api/projects/:projectId/search',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      res.json({ query: q, hits: await searchProject(db, orgId, projectId, q) });
    }),
  );

  return router;
}
