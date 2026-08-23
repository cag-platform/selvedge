import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { createPack, deletePack, getPack, listPacks, setPackMuted, updateHumanSections } from '../../packs/store.js';
import { PackValidationError } from '../../packs/validate.js';
import { scaffoldPack, slugifyProjectId, type NewProjectInput } from '../../packs/scaffold.js';
import { GithubError } from '../../connectors/github/newRepo.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createProject } from '../../packs/create.js';
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

      // ONE COPY OF THE ORDERING. The plan gate before anything is made, the
      // repo before the pack — see packs/create.ts, which the idea-chat's
      // "start a new one" also goes through. Two doors, one sequence.
      const made = await createProject(
        db,
        orgId,
        {
          name: body.name.trim(),
          repo: createRepo ? null : body.repo!.trim(),
          tier: body.tier!,
          ...(body.touches_money !== undefined ? { touchesMoney: body.touches_money } : {}),
          ...(body.downtime_translation ? { downtimeTranslation: body.downtime_translation } : {}),
        },
        deps.createRepo ? { createRepo: deps.createRepo } : {},
      );
      if (!made.ok) {
        if (made.kind === 'limit') {
          refuse(res, made.allowance);
          return;
        }
        res.status(made.status).json(made.details ? { error: made.error, details: made.details } : { error: made.error });
        return;
      }
      const pack = made.pack;

      // Seed 30 days of history for the newly mapped repo in the background.
      if (deps.backfill) {
        void deps.backfill(orgId, pack.topology.sources[0]!.resource_id).catch((err) => {
          console.error(`backfill after pack create failed for ${orgId}/${pack.identity.project_id}:`, err);
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
