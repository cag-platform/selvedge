import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { createPack, deletePack, getPack, listPacks, setPackMuted, updateHumanSections } from '../../packs/store.js';
import { PackValidationError } from '../../packs/validate.js';
import { scaffoldPack, slugifyProjectId, type NewProjectInput } from '../../packs/scaffold.js';
import { GithubError } from '../../connectors/github/newRepo.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { canCreateProject } from '../../billing/entitlements.js';
import { refuse } from '../middleware/limit.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

const TIERS = new Set(['sandbox', 'personal', 'live_small', 'live_critical']);

export type PacksRouterDeps = {
  /** Fire-and-forget history seed for a newly mapped repo; injected so tests don't need GitHub credentials. */
  backfill?: (orgId: string, repo: string) => Promise<void>;
  /** Create a fresh private repo for a start-from-nothing project. Absent when GITHUB_TOKEN isn't configured. */
  createRepo?: (name: string, description: string) => Promise<{ fullName: string }>;
};

export function createPacksRouter(db: Db, deps: PacksRouterDeps = {}) {
  const router = Router();

  router.post(
    '/api/packs',
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<NewProjectInput> & { create_repo?: boolean };
      const createRepo = body.create_repo === true;
      if (!body.name?.trim() || (!createRepo && !body.repo?.trim()) || !TIERS.has(body.tier ?? '')) {
        res.status(400).json({ error: 'name, repo, and a valid tier are required' });
        return;
      }
      if (!createRepo && !/^[^/\s]+\/[^/\s]+$/.test(body.repo!.trim())) {
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
      // Checked here, before anything is made — and specifically before the
      // start-from-nothing branch below creates a real repo on GitHub. A limit
      // that bites after a side effect leaves the owner with a repo they didn't
      // get to use and no project attached to it.
      const room = await canCreateProject(db, orgId);
      if (!room.allowed) {
        refuse(res, room);
        return;
      }
      // Start-from-nothing: make the repo first, then map the project to it.
      // The repo is created before the pack so a GitHub failure leaves nothing
      // half-made; a pack failure after leaves a repo but no project — visible
      // and harmless, and re-creating the project just maps to it by name.
      let repo: string;
      if (createRepo) {
        if (!deps.createRepo) {
          res.status(503).json({ error: 'Creating repos needs the build engine’s GITHUB_TOKEN — set it, or pick an existing repo.' });
          return;
        }
        try {
          repo = (await deps.createRepo(projectId, `${body.name.trim()} — created by Selvedge`)).fullName;
        } catch (err) {
          if (err instanceof GithubError) {
            res.status(err.alreadyExists ? 409 : 502).json({ error: `GitHub did not create the repo: ${err.message}. Nothing was created.` });
            return;
          }
          throw err;
        }
      } else {
        repo = body.repo!.trim();
      }
      const pack = scaffoldPack({
        name: body.name.trim(),
        repo,
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

  // Mute / unmute a project — the softer "deprioritize". Kept out of the daily
  // brief but still listed (collapsed). Reversible, unlike delete.
  router.patch(
    '/api/packs/:projectId/mute',
    asyncHandler(async (req, res) => {
      const { muted } = req.body as { muted?: unknown };
      if (typeof muted !== 'boolean') {
        res.status(400).json({ error: 'muted (boolean) is required' });
        return;
      }
      const ok = await setPackMuted(db, orgIdOf(req), req.params.projectId!, muted);
      if (!ok) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ ok: true, muted });
    }),
  );

  // Delete a project permanently (deliberate, no undo): purges its narrations
  // and events, and archives the pack as a tombstone so the GitHub connector
  // won't resurrect the repo. 404 when the project isn't there (or already
  // deleted).
  router.delete(
    '/api/packs/:projectId',
    asyncHandler(async (req, res) => {
      const deleted = await deletePack(db, orgIdOf(req), req.params.projectId!);
      if (!deleted) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
