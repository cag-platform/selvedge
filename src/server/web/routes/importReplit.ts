import { Router, type Request } from 'express';
import multer from 'multer';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { readAppZip } from '../../import/replitApp.js';
import { createProject, type CreateDeps } from '../../packs/create.js';
import { refuse } from '../middleware/limit.js';
import { ensureWorkshopThread } from '../../threads/store.js';
import { getPack } from '../../packs/store.js';
import { GithubError } from '../../connectors/github/newRepo.js';
import { pushFilesToRepo, type PushResult } from '../../connectors/github/pushFiles.js';
import { inspectProjectFiles } from '../../import/projectMap.js';
import { buildMigrationPlan, rebuildMigrationPlan, recordMigrationVerification, recordPreviewPreparation, recordWorkspacePreparation } from '../../import/migrationPlan.js';
import { attachBrowserEvidence, verifyMigrationPreview } from '../../import/previewVerifier.js';
import { captureMigrationBrowserEvidence, type MigrationBrowserEvidence } from '../../import/browserEvidence.js';
import type { MigrationVerification } from '../../../shared/types/migration.js';
import { configFor } from '../../build/engineConfig.js';
import { ensureSandbox } from '../../build/sandbox.js';
import { canStartBuild } from '../../billing/entitlements.js';
import { ensurePreview, type PreviewStatus } from '../../build/preview.js';
import { getBuild } from '../../build/store.js';
import { migrationJourneys } from '../../db/schema/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { migrationEvidenceStorageKey, visualObjectStore, type VisualObjectStore } from '../../visuals/storage.js';

/**
 * IMPORT FROM REPLIT — the migration door.
 *
 * Not a chat import: the thing coming through is a working APP, on its way
 * from a workspace somebody rents to a repo they own. Replit's own export is
 * the zip download, so the flow is: zip in → workspace junk filtered and named
 * → a repo minted under the owner's GitHub → the files landed as one commit →
 * a Selvedge project around it, workshop open. The Repl's agent history does
 * not come along, because Replit offers no export of it, and scraping what a
 * vendor won't export is a feature that breaks the week they change a div.
 *
 * TWO MODES, ONE DOOR. With a `name`, it creates the project (plan gate first,
 * repo before pack — createProject's ordering, reused not restated). With a
 * `project_id`, it pushes into a project that already exists — which is both
 * the retry path when a first attempt made the project and then failed to
 * land the files, and the "bring the real code into the repo I already made"
 * path. Pushing layers a commit on top; it never rewrites what is there.
 *
 * THE SECRETS DO NOT RIDE IN THE ZIP. A Repl's env is in Replit's vault, not
 * its filesystem, so nothing here handles them — the response points at the
 * preview environment box, which is the screen built for exactly that paste.
 */

const MAX_ZIP_BYTES = 200 * 1024 * 1024;

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export type ImportReplitDeps = CreateDeps & {
  push?: typeof pushFilesToRepo;
  prepareWorkspace?: (orgId: string, projectId: string) => Promise<{ ok: true; workspaceId: string } | { ok: false; status: number; error: string }>;
  startPreview?: (orgId: string, projectId: string) => Promise<PreviewStatus>;
  verifyPreview?: (url: string) => Promise<MigrationVerification>;
  captureBrowserEvidence?: (url: string) => Promise<MigrationBrowserEvidence>;
  visualStore?: VisualObjectStore | null;
};

export function createImportReplitRouter(db: Db, deps: ImportReplitDeps = {}) {
  const router = Router();
  const push = deps.push ?? pushFilesToRepo;
  const prepareWorkspace = deps.prepareWorkspace ?? (async (orgId: string, projectId: string) => {
    const config = await configFor(db, orgId, projectId);
    if ('error' in config) return { ok: false as const, status: config.status, error: config.error };
    try {
      const workspace = await ensureSandbox(db, orgId, projectId, config.cfg);
      return { ok: true as const, workspaceId: workspace.id };
    } catch (error) {
      return { ok: false as const, status: 503, error: error instanceof Error ? error.message : 'The workspace could not be prepared.' };
    }
  });
  const startPreview = deps.startPreview ?? (async (orgId: string, projectId: string) => {
    const config = await configFor(db, orgId, projectId);
    if ('error' in config) return { state: 'error' as const, url: null, message: config.error };
    return ensurePreview(db, orgId, projectId, config.cfg);
  });
  const verifyPreview = deps.verifyPreview ?? verifyMigrationPreview;
  const captureBrowserEvidence = deps.captureBrowserEvidence ?? captureMigrationBrowserEvidence;
  const visualStore = deps.visualStore === undefined ? visualObjectStore() : deps.visualStore;
  const migrationResponse = async (row: typeof migrationJourneys.$inferSelect) => {
    const destinations = row.destinations as Record<string, string>;
    const plan = row.migrationPlan ?? buildMigrationPlan(row.projectMap, destinations, row.updatedAt);
    const build = await getBuild(db, row.orgId, row.projectId);
    const previewStep = plan.steps.find((step) => step.id === 'preview');
    const preview = build?.previewUrl
      ? { state: 'ready', url: build.previewUrl, message: null }
      : previewStep?.state === 'blocked'
        ? { state: 'error', url: null, message: previewStep.blockers[0] ?? previewStep.detail }
        : previewStep?.state === 'complete'
          ? { state: 'none', url: null, message: previewStep.detail }
          : { state: 'pending', url: null, message: null };
    return { id: row.id, project_id: row.projectId, source: row.source, state: row.state, original_untouched: row.originalUntouched, project_map: row.projectMap, migration_plan: plan, verification: row.migrationVerification, preview, destinations, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } }).single('file');

  router.get('/api/projects/:projectId/migration', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const [row] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, req.params.projectId ?? ''))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!row) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    res.json(await migrationResponse(row));
  }));

  router.get('/api/projects/:projectId/migration/screenshots/:artifactId', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const artifactId = req.params.artifactId ?? '';
    const [row] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!row?.migrationVerification?.screenshot_artifact_ids.includes(artifactId)) { res.status(404).json({ error: 'No such migration screenshot.' }); return; }
    if (!visualStore) { res.status(503).json({ error: 'Migration evidence storage is not configured.' }); return; }
    res.redirect(302, await visualStore.signedGet(migrationEvidenceStorageKey(orgId, artifactId)));
  }));

  router.patch('/api/projects/:projectId/migration/destinations', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hosting = typeof body.hosting === 'string' ? body.hosting : '';
    const database = typeof body.database === 'string' ? body.database : '';
    const allowedHosting = new Set(['owner', 'railway', 'vercel', 'cloudflare']);
    const allowedDatabase = new Set(['owner', 'neon', 'supabase']);
    if (!allowedHosting.has(hosting) || !allowedDatabase.has(database)) {
      res.status(400).json({ error: 'Choose a supported hosting and database destination.' }); return;
    }
    const destinations = { ...(current.destinations as Record<string, unknown>), hosting, database };
    const migrationPlan = current.migrationPlan
      ? rebuildMigrationPlan(current.projectMap, destinations as Record<string, string>, current.migrationPlan)
      : buildMigrationPlan(current.projectMap, destinations as Record<string, string>);
    const [updated] = await db.update(migrationJourneys).set({ destinations, migrationPlan, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    res.json(await migrationResponse(updated!));
  }));

  router.post('/api/projects/:projectId/migration/workspace', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    const allowance = await canStartBuild(db, orgId);
    if (!allowance.allowed) { refuse(res, allowance); return; }
    const prepared = await prepareWorkspace(orgId, projectId);
    const migrationPlan = recordWorkspacePreparation(
      current.migrationPlan ?? buildMigrationPlan(current.projectMap, current.destinations as Record<string, string>),
      prepared.ok ? { ok: true } : { ok: false, reason: prepared.error },
    );
    const [updated] = await db.update(migrationJourneys).set({ migrationPlan, state: prepared.ok ? 'copying' : 'mapped', updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    if (!prepared.ok) { res.status(prepared.status).json({ error: prepared.error, migration_plan: migrationPlan }); return; }
    const preview = await startPreview(orgId, projectId);
    const previewPlan = recordPreviewPreparation(migrationPlan, preview);
    const nextState = preview.state === 'ready' ? 'preview_ready' : 'copying';
    const [withPreview] = await db.update(migrationJourneys).set({ migrationPlan: previewPlan, state: nextState, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    res.json({ workspace_id: prepared.workspaceId, state: withPreview!.state, migration_plan: withPreview!.migrationPlan, preview, original_untouched: withPreview!.originalUntouched });
  }));

  router.post('/api/projects/:projectId/migration/verify', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    const build = await getBuild(db, orgId, projectId);
    if (!build?.previewUrl) { res.status(409).json({ error: 'The migrated app needs a running preview before it can be verified.' }); return; }
    let verification = await verifyPreview(build.previewUrl);
    if (!deps.verifyPreview || deps.captureBrowserEvidence) {
      const evidence = await captureBrowserEvidence(build.previewUrl);
      const screenshotIds: string[] = [];
      if (visualStore) {
        try {
          for (const screenshot of evidence.screenshots) {
            const artifactId = `${ulid()}-${screenshot.id}`;
            await visualStore.put(migrationEvidenceStorageKey(orgId, artifactId), screenshot.bytes, screenshot.mime);
            screenshotIds.push(artifactId);
          }
        } catch (error) {
          evidence.error ??= `Browser evidence could not be stored: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
        }
      } else {
        evidence.error ??= 'Migration evidence storage is not configured.';
      }
      verification = attachBrowserEvidence(verification, evidence, screenshotIds);
    }
    const migrationPlan = recordMigrationVerification(current.migrationPlan ?? buildMigrationPlan(current.projectMap, current.destinations as Record<string, string>), verification);
    const state = verification.status === 'passed' ? 'verified' : 'preview_ready';
    await db.update(migrationJourneys).set({ migrationPlan, migrationVerification: verification, state, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id)));
    res.json({ state, verification, migration_plan: migrationPlan, original_untouched: current.originalUntouched });
  }));

  router.post(
    '/api/import/replit',
    (req, res, next) => {
      upload(req, res, (err: unknown) => {
        if (!err) return next();
        const tooBig = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
        res.status(400).json({
          error: tooBig
            ? `that zip is over ${MAX_ZIP_BYTES / 1024 / 1024}MB. Most of a Repl zip is usually node_modules — delete it from the Repl before downloading, and the export shrinks to the app itself.`
            : "I couldn't read that upload.",
        });
      });
    },
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const file = (req as Request & { file?: { buffer?: Buffer } }).file;
      if (!file?.buffer) {
        res.status(400).json({ error: 'No file came with that — download the Repl as a zip and choose it here.' });
        return;
      }

      // The zip is validated BEFORE anything is created, so a refusal here
      // costs nothing and a plan-limit refusal never follows a minted repo.
      const read = readAppZip(file.buffer);
      if (!read.ok) {
        res.status(400).json({ error: read.error });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const existingId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      if ((name === '') === (existingId === '')) {
        res.status(400).json({ error: 'Say what to call it, or which project it goes into — one or the other.' });
        return;
      }

      let projectId: string;
      let repo: string;
      if (existingId) {
        const pack = await getPack(db, orgId, existingId);
        if (!pack) {
          res.status(404).json({ error: 'no such project' });
          return;
        }
        const source = pack.topology.sources.find((s) => s.connector === 'github');
        if (!source) {
          res.status(409).json({ error: 'that project has no GitHub repo to push into.' });
          return;
        }
        projectId = existingId;
        repo = source.resource_id;
      } else {
        const made = await createProject(db, orgId, { name, repo: null, tier: 'personal' }, deps);
        if (!made.ok) {
          if (made.kind === 'limit') {
            refuse(res, made.allowance);
            return;
          }
          res.status(made.status).json({ error: made.error, ...(made.details ? { details: made.details } : {}) });
          return;
        }
        projectId = made.pack.identity.project_id;
        repo = made.pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? '';
      }

      let pushed: PushResult;
      try {
        pushed = await push(repo, read.files, 'Imported from Replit');
      } catch (err) {
        if (err instanceof GithubError) {
          // The project exists and the files did not land — said exactly, with
          // the way through, because "it failed" after a repo was minted is
          // the kind of half-state that otherwise costs an hour of confusion.
          res.status(502).json({
            error: `The project was created but the files did not land: ${err.message}. Upload the same zip again into "${projectId}" — pushing layers, it never duplicates the project.`,
            project_id: projectId,
          });
          return;
        }
        throw err;
      }

      const thread = await ensureWorkshopThread(db, orgId, projectId);
      const projectMap = inspectProjectFiles(read.files);
      const destinations = { repository: repo };
      const migrationPlan = buildMigrationPlan(projectMap, destinations);
      const migrationId = ulid();
      await db.insert(migrationJourneys).values({ id: migrationId, orgId, projectId, source: 'replit', state: 'mapped', originalUntouched: true, projectMap, migrationPlan, destinations });
      res.json({
        migration_id: migrationId,
        project_id: projectId,
        thread_id: thread.id,
        repo,
        files: pushed.files,
        // What was left behind, by name — "your Repl is in" must never quietly
        // mean "except the parts I decided about".
        skipped: read.skipped,
        skipped_count: read.skippedCount,
        project_map: projectMap,
        migration_plan: migrationPlan,
        summary:
          `${pushed.files} files landed in ${repo}` +
          (read.skippedCount > 0 ? ` — workspace junk left behind: ${read.skipped.join(', ')} (${read.skippedCount} files)` : '') +
          '. Secrets do not travel in a zip: paste the .env into the preview environment when the preview asks.',
      });
    }),
  );

  return router;
}
