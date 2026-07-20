import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { createPack, getPack, listPacks, updateHumanSections } from '../../packs/store.js';
import { PackValidationError } from '../../packs/validate.js';
import { scaffoldPack, slugifyProjectId, type NewProjectInput } from '../../packs/scaffold.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

const TIERS = new Set(['sandbox', 'personal', 'live_small', 'live_critical']);

export type PacksRouterDeps = {
  /** Fire-and-forget history seed for a newly mapped repo; injected so tests don't need GitHub credentials. */
  backfill?: (orgId: string, repo: string) => Promise<void>;
};

export function createPacksRouter(db: Db, deps: PacksRouterDeps = {}) {
  const router = Router();

  router.post(
    '/api/packs',
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<NewProjectInput>;
      if (!body.name?.trim() || !body.repo?.trim() || !TIERS.has(body.tier ?? '')) {
        res.status(400).json({ error: 'name, repo, and a valid tier are required' });
        return;
      }
      if (!/^[^/\s]+\/[^/\s]+$/.test(body.repo.trim())) {
        res.status(400).json({ error: 'repo must be a GitHub full name like "owner/repo"' });
        return;
      }
      const orgId = orgIdOf(req);
      const projectId = slugifyProjectId(body.name);
      if (!projectId) {
        res.status(400).json({ error: 'name must contain at least one letter or number' });
        return;
      }
      if (await getPack(db, orgId, projectId)) {
        res.status(409).json({ error: `a project with id "${projectId}" already exists` });
        return;
      }
      const pack = scaffoldPack({
        name: body.name.trim(),
        repo: body.repo.trim(),
        tier: body.tier!,
        touches_money: body.touches_money,
        downtime_translation: body.downtime_translation?.trim() || undefined,
      });
      try {
        await createPack(db, orgId, pack);
      } catch (err) {
        if (err instanceof PackValidationError) {
          res.status(422).json({ error: err.message, details: err.errors });
          return;
        }
        throw err;
      }
      // Seed 30 days of history for the newly mapped repo in the background.
      if (deps.backfill) {
        void deps.backfill(orgId, pack.topology.sources[0]!.resource_id).catch((err) => {
          console.error(`backfill after pack create failed for ${orgId}/${projectId}:`, err);
        });
      }
      res.status(201).json(pack);
    }),
  );

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
