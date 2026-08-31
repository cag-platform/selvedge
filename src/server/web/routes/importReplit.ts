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
import { pushFilesToRepoWithToken } from '../../connectors/github/pushFiles.js';
import { provisionMigrationRepo, type ProvisionedMigrationRepo } from '../../connectors/github/migrationRepo.js';
import { resolveRepoToken } from '../../build/repoToken.js';
import { inspectProjectFiles } from '../../import/projectMap.js';
import { buildMigrationPlan, rebuildMigrationPlan, recordMigrationVerification, recordOwnerTestFlow, recordPreviewPreparation, recordWorkspacePreparation } from '../../import/migrationPlan.js';
import { attachBrowserEvidence, verifyMigrationPreview } from '../../import/previewVerifier.js';
import { captureMigrationBrowserEvidence, type MigrationBrowserEvidence } from '../../import/browserEvidence.js';
import { planMigrationGuidedJourney } from '../../import/guidedJourney.js';
import type { MigrationVerification } from '../../../shared/types/migration.js';
import { configFor } from '../../build/engineConfig.js';
import { ensureSandbox } from '../../build/sandbox.js';
import { canStartBuild } from '../../billing/entitlements.js';
import { ensurePreview, invalidatePreview, type PreviewStatus } from '../../build/preview.js';
import { getBuild } from '../../build/store.js';
import { getPreviewEnvSummary, mergePreviewEnv } from '../../build/previewEnv.js';
import { migrationJourneys } from '../../db/schema/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { migrationEvidenceStorageKey, visualObjectStore, type VisualObjectStore } from '../../visuals/storage.js';
import { approveOwnerTestFlowStep, createOwnerTestFlow } from '../../import/ownerTestFlow.js';
import { runOwnerTestFlow, type OwnerFlowRun } from '../../import/ownerTestFlowRunner.js';
import { configuredMigrationTestInputIds, consumeMigrationTestInputs, deleteMigrationTestInputs, storeMigrationTestInputs, type OwnerTestInputValues } from '../../import/migrationTestInputs.js';
import { readGithubProjectFiles, type GithubProjectFiles } from '../../import/githubProjectFiles.js';
import { resolveProjectId } from '../../resolution/resolveProject.js';
import { canCreateProject } from '../../billing/entitlements.js';
import { slugifyProjectId } from '../../packs/scaffold.js';

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
  provisionRepo?: (orgId: string, name: string, description: string, files: Array<{ path: string; bytes: Uint8Array }>) => Promise<ProvisionedMigrationRepo>;
  prepareWorkspace?: (orgId: string, projectId: string) => Promise<{ ok: true; workspaceId: string } | { ok: false; status: number; error: string }>;
  startPreview?: (orgId: string, projectId: string) => Promise<PreviewStatus>;
  verifyPreview?: (url: string) => Promise<MigrationVerification>;
  captureBrowserEvidence?: (url: string) => Promise<MigrationBrowserEvidence>;
  visualStore?: VisualObjectStore | null;
  planOwnerTestFlow?: typeof createOwnerTestFlow;
  executeOwnerTestFlow?: (orgId: string, previewUrl: string, flow: NonNullable<(typeof migrationJourneys.$inferSelect)['ownerTestFlow']>, inputs?: OwnerTestInputValues) => Promise<OwnerFlowRun>;
  inspectGithubRepo?: (orgId: string, repo: string) => Promise<GithubProjectFiles>;
};

export function createImportReplitRouter(db: Db, deps: ImportReplitDeps = {}) {
  const router = Router();
  const pushExisting = async (orgId: string, repo: string, files: Array<{ path: string; bytes: Uint8Array }>): Promise<PushResult> => {
    if (deps.push) return deps.push(repo, files, 'Imported from Replit');
    const credential = await resolveRepoToken(db, orgId, repo);
    if (!credential.ok) throw new GithubError(credential.reason);
    return pushFilesToRepoWithToken(credential.token, repo, files, 'Imported from Replit');
  };
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
    const configured = row.ownerTestFlow ? await configuredMigrationTestInputIds(db, row.orgId, row.id) : new Set<string>();
    const previewEnv = await getPreviewEnvSummary(db, row.orgId, row.projectId);
    const authDetected = row.projectMap.items.some((item) => item.kind === 'auth' && item.status === 'found');
    const integrationDetected = row.projectMap.items.some((item) => item.kind === 'integration' && item.status === 'found');
    const clerkConfigured = ['VITE_CLERK_PUBLISHABLE_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'].every((key) => previewEnv.keys.includes(key));
    const requirements = [
      ...(authDetected ? [{ id: 'clerk' as const, label: 'Development sign-in', status: clerkConfigured ? 'ready' as const : 'needs_connection' as const, detail: clerkConfigured ? 'Development Clerk keys are stored and will be used only by the temporary preview.' : 'Connect a Clerk development instance so Selvedge can render and test signed-in behavior without production credentials.', configured_keys: previewEnv.keys.filter((key) => key.includes('CLERK')) }] : []),
      ...(row.source === 'replit' ? [{ id: 'replit_integrations' as const, label: 'Replit-managed connections', status: integrationDetected ? 'needs_rebuild' as const : 'needs_review' as const, detail: integrationDetected ? 'One or more integrations depend on Replit. A coding agent must replace each with its normal provider connection before cutover.' : 'Selvedge will confirm that no Replit-only connection remains before cutover.', configured_keys: [] }] : []),
    ];
    const testFlow = row.ownerTestFlow ? { ...row.ownerTestFlow, steps: row.ownerTestFlow.steps.map((step) => ({ ...step, input_requirements: (step.input_requirements ?? []).map((input) => ({ ...input, configured: configured.has(`${step.id}:${input.id}`) })) })) } : null;
    return { id: row.id, project_id: row.projectId, source: row.source, state: row.state, original_untouched: row.originalUntouched, project_map: row.projectMap, migration_plan: plan, verification: row.migrationVerification, test_flow: testFlow, preview, destinations, account_bridge: { requirements }, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } }).single('file');

  router.post('/api/import/github', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    const source = body.source;
    const allowedSources = new Set(['github', 'codex', 'claude-code', 'cursor', 'lovable']);
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || typeof source !== 'string' || !allowedSources.has(source)) { res.status(400).json({ error: 'Choose an installed repository and say where the project is coming from.' }); return; }
    let inspected: GithubProjectFiles;
    try { inspected = await (deps.inspectGithubRepo ? deps.inspectGithubRepo(orgId, repo) : readGithubProjectFiles(db, orgId, repo)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Selvedge could not inspect that repository.' }); return; }
    let projectId = await resolveProjectId(db, orgId, 'github', repo);
    if (projectId && !(await getPack(db, orgId, projectId))) { res.status(409).json({ error: 'This repository belonged to a project you removed. Restore that project before starting a migration from it.' }); return; }
    if (!projectId) {
      const requestedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : repo.split('/')[1]!.replace(/[-_]+/g, ' ');
      const made = await createProject(db, orgId, { name: requestedName, repo, tier: 'personal' }, deps);
      if (!made.ok) { if (made.kind === 'limit') { refuse(res, made.allowance); return; } res.status(made.status).json({ error: made.error }); return; }
      projectId = made.pack.identity.project_id;
    }
    const thread = await ensureWorkshopThread(db, orgId, projectId);
    const projectMap = inspectProjectFiles(inspected.files);
    if (inspected.truncated) projectMap.limitations.push('The GitHub tree was larger than the 2,000-file inspection boundary; the workspace agent will inspect the complete checkout.');
    const destinations = { repository: repo };
    const migrationPlan = buildMigrationPlan(projectMap, destinations);
    const migrationId = ulid();
    await db.insert(migrationJourneys).values({ id: migrationId, orgId, projectId, source: source as typeof migrationJourneys.$inferInsert.source, state: 'mapped', originalUntouched: true, projectMap, migrationPlan, destinations });
    res.status(201).json({ migration_id: migrationId, project_id: projectId, thread_id: thread.id, repo, default_branch: inspected.defaultBranch, project_map: projectMap, migration_plan: migrationPlan });
  }));

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
    const verificationOwns = row?.migrationVerification?.screenshot_artifact_ids.includes(artifactId) ?? false;
    const ownerFlowOwns = row?.ownerTestFlow?.steps.some((step) => step.evidence_artifact_ids.includes(artifactId)) ?? false;
    if (!verificationOwns && !ownerFlowOwns) { res.status(404).json({ error: 'No such migration screenshot.' }); return; }
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

  router.post('/api/projects/:projectId/migration/test-flow', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    if (goal.length < 8 || goal.length > 1_000) { res.status(400).json({ error: 'Describe the journey in one clear sentence, between 8 and 1,000 characters.' }); return; }
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    const flow = await (deps.planOwnerTestFlow ?? createOwnerTestFlow)(db, orgId, goal);
    if (!flow) { res.status(503).json({ error: 'Selvedge could not safely turn that journey into a test plan right now. Nothing was approved or run.' }); return; }
    await deleteMigrationTestInputs(db, orgId, current.id);
    const migrationPlan = recordOwnerTestFlow(current.migrationPlan ?? buildMigrationPlan(current.projectMap, current.destinations as Record<string, string>), flow);
    const [updated] = await db.update(migrationJourneys).set({ ownerTestFlow: flow, migrationPlan, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    res.json(await migrationResponse(updated!));
  }));

  router.post('/api/projects/:projectId/migration/test-flow/:stepId/approve', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current?.ownerTestFlow) { res.status(404).json({ error: 'No owner-defined test flow exists for this project.' }); return; }
    const flow = approveOwnerTestFlowStep(current.ownerTestFlow, req.params.stepId ?? '');
    if (!flow) { res.status(409).json({ error: 'That approval boundary is no longer waiting for approval.' }); return; }
    const migrationPlan = recordOwnerTestFlow(current.migrationPlan ?? buildMigrationPlan(current.projectMap, current.destinations as Record<string, string>), flow);
    const [updated] = await db.update(migrationJourneys).set({ ownerTestFlow: flow, migrationPlan, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    res.json(await migrationResponse(updated!));
  }));

  router.put('/api/projects/:projectId/migration/test-flow/:stepId/inputs', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current?.ownerTestFlow) { res.status(404).json({ error: 'No owner-defined test flow exists for this project.' }); return; }
    const step = current.ownerTestFlow.steps.find((item) => item.id === (req.params.stepId ?? ''));
    if (!step || !(step.input_requirements ?? []).length) { res.status(404).json({ error: 'That step does not request temporary test values.' }); return; }
    if (req.body?.declared_non_production !== true) { res.status(400).json({ error: 'Confirm these are development-only test values. Production credentials are refused.' }); return; }
    if (req.body?.production === true) { res.status(400).json({ error: 'Production credentials cannot be used in a migration preview test.' }); return; }
    const values = req.body?.values && typeof req.body.values === 'object' && !Array.isArray(req.body.values) ? req.body.values as Record<string, string> : {};
    try { await storeMigrationTestInputs(db, orgId, projectId, current.id, step, values); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Temporary test values could not be stored safely.' }); return; }
    res.json(await migrationResponse(current));
  }));

  router.post('/api/projects/:projectId/migration/test-flow/run', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current?.ownerTestFlow) { res.status(404).json({ error: 'No owner-defined test flow exists for this project.' }); return; }
    if (current.ownerTestFlow.status !== 'ready') { res.status(409).json({ error: 'Every approval boundary must be approved before this flow can run.' }); return; }
    const build = await getBuild(db, orgId, projectId);
    if (!build?.previewUrl) { res.status(409).json({ error: 'The isolated preview must be running before this flow can run.' }); return; }
    if (!visualStore) { res.status(503).json({ error: 'Evidence storage is unavailable, so Selvedge will not run a flow it cannot prove.' }); return; }
    let inputValues: OwnerTestInputValues;
    try { inputValues = await consumeMigrationTestInputs(db, orgId, current.id, current.ownerTestFlow); }
    catch { await deleteMigrationTestInputs(db, orgId, current.id); res.status(409).json({ error: 'The temporary test values could not be opened safely. Enter fresh development-only values and try again.' }); return; }
    const missingInputs = current.ownerTestFlow.steps.flatMap((step) => (step.input_requirements ?? []).filter((input) => !inputValues[step.id]?.[input.id]).map((input) => input.label));
    if (missingInputs.length) { res.status(409).json({ error: `Add development-only test values for: ${missingInputs.join(', ')}.` }); return; }
    const runningFlow = { ...current.ownerTestFlow, status: 'running' as const, steps: current.ownerTestFlow.steps.map((step) => step.state === 'ready' || step.state === 'approved' ? { ...step, state: 'running' as const } : step), updated_at: new Date().toISOString() };
    await db.update(migrationJourneys).set({ ownerTestFlow: runningFlow, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id)));
    let result: OwnerFlowRun;
    try { result = deps.executeOwnerTestFlow ? await deps.executeOwnerTestFlow(orgId, build.previewUrl, current.ownerTestFlow, inputValues) : await runOwnerTestFlow(db, orgId, build.previewUrl, current.ownerTestFlow, undefined, inputValues); }
    finally { await deleteMigrationTestInputs(db, orgId, current.id); }
    let flow = result.flow;
    try {
      for (const screenshot of result.screenshots) {
        const artifactId = `${ulid()}-owner-${screenshot.stepId}`;
        await visualStore.put(migrationEvidenceStorageKey(orgId, artifactId), screenshot.bytes, screenshot.mime);
        flow = { ...flow, steps: flow.steps.map((step) => step.id === screenshot.stepId ? { ...step, evidence_artifact_ids: [...step.evidence_artifact_ids, artifactId] } : step) };
      }
    } catch (error) {
      flow = { ...flow, status: 'failed', steps: flow.steps.map((step) => step.state === 'passed' ? { ...step, state: 'failed', result_detail: `The interaction ran, but its evidence could not be stored: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) } : step), updated_at: new Date().toISOString() };
    }
    const migrationPlan = recordOwnerTestFlow(current.migrationPlan ?? buildMigrationPlan(current.projectMap, current.destinations as Record<string, string>), flow);
    const [updated] = await db.update(migrationJourneys).set({ ownerTestFlow: flow, migrationPlan, updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
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
    // A relay URL is a short-lived capability and may have belonged to a
    // previous Selvedge process. Verification always wakes/reissues the
    // private preview first so it can never grade an expired URL while the
    // current Blaxel workspace is healthy.
    const preview = await startPreview(orgId, projectId);
    if (preview.state !== 'ready' || !preview.url) { res.status(409).json({ error: preview.message ?? 'The migrated app needs a running preview before it can be verified.' }); return; }
    let verification = await verifyPreview(preview.url);
    if (!deps.verifyPreview || deps.captureBrowserEvidence) {
      const evidence = deps.captureBrowserEvidence
        ? await deps.captureBrowserEvidence(preview.url)
        : await captureMigrationBrowserEvidence(preview.url, (candidates) => planMigrationGuidedJourney(db, orgId, candidates));
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

  router.put('/api/projects/:projectId/migration/account-bridge/clerk', asyncHandler(async (req, res) => {
    const orgId = orgIdOf(req);
    const projectId = req.params.projectId ?? '';
    const [current] = await db.select().from(migrationJourneys).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.projectId, projectId))).orderBy(desc(migrationJourneys.updatedAt)).limit(1);
    if (!current) { res.status(404).json({ error: 'No migration record exists for this project.' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publishable = typeof body.publishable_key === 'string' ? body.publishable_key.trim() : '';
    const secret = typeof body.secret_key === 'string' ? body.secret_key.trim() : '';
    if (body.development_only !== true) { res.status(400).json({ error: 'Confirm that these belong to a development Clerk instance.' }); return; }
    if (!publishable.startsWith('pk_test_') || !secret.startsWith('sk_test_')) { res.status(400).json({ error: 'Use Clerk test keys (pk_test_… and sk_test_…). Production sign-in keys are not accepted in a temporary preview.' }); return; }
    const config = await configFor(db, orgId, projectId);
    if ('error' in config) { res.status(config.status).json({ error: config.error }); return; }
    await mergePreviewEnv(db, orgId, projectId, [
      { key: 'VITE_CLERK_PUBLISHABLE_KEY', value: publishable },
      { key: 'CLERK_PUBLISHABLE_KEY', value: publishable },
      { key: 'CLERK_SECRET_KEY', value: secret },
    ]);
    await invalidatePreview(db, orgId, projectId, config.cfg);
    const [updated] = await db.update(migrationJourneys).set({ migrationVerification: null, state: 'copying', updatedAt: new Date() }).where(and(eq(migrationJourneys.orgId, orgId), eq(migrationJourneys.id, current.id))).returning();
    res.json(await migrationResponse(updated!));
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
      let pushed: PushResult;
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
        try {
          pushed = await pushExisting(orgId, repo, read.files);
        } catch (err) {
          if (err instanceof GithubError) {
            res.status(502).json({ error: `The files did not land in ${repo}: ${err.message}. Check the GitHub App's access to this repository and try again.`, project_id: projectId });
            return;
          }
          throw err;
        }
      } else {
        // Validate the local project id and subscription gate before GitHub is
        // changed. The provisioner then creates AND fills the repo with one
        // short-lived installation credential; only a complete repo becomes a
        // Selvedge project, eliminating the old half-created project state.
        const projectSlug = slugifyProjectId(name);
        if (!projectSlug) { res.status(400).json({ error: 'name must contain at least one letter or number' }); return; }
        if (await getPack(db, orgId, projectSlug)) { res.status(409).json({ error: `a project with id "${projectSlug}" already exists` }); return; }
        const room = await canCreateProject(db, orgId);
        if (!room.allowed) { refuse(res, room); return; }

        if (deps.createRepo || deps.push) {
          // Injectable compatibility seam for local/self-hosted deployments and
          // deterministic route tests. Production does not pass either dep.
          const made = await createProject(db, orgId, { name, repo: null, tier: 'personal' }, deps);
          if (!made.ok) {
            if (made.kind === 'limit') { refuse(res, made.allowance); return; }
            res.status(made.status).json({ error: made.error, ...(made.details ? { details: made.details } : {}) });
            return;
          }
          projectId = made.pack.identity.project_id;
          repo = made.pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? '';
          try { pushed = await pushExisting(orgId, repo, read.files); }
          catch (err) {
            if (err instanceof GithubError) { res.status(502).json({ error: `The project was created but the files did not land: ${err.message}. Upload the same zip again into "${projectId}" — pushing layers, it never duplicates the project.`, project_id: projectId }); return; }
            throw err;
          }
        } else {
          let provisioned: ProvisionedMigrationRepo;
          try {
            provisioned = await (deps.provisionRepo ?? ((tenant, repoName, description, files) => provisionMigrationRepo(db, tenant, repoName, description, files)))(orgId, projectSlug, `${name} — migrated by Selvedge`, read.files);
          } catch (err) {
            if (err instanceof GithubError) {
              res.status(err.alreadyExists ? 409 : 409).json({ error: err.message, code: 'github_authorization_required', connect_url: '/api/connectors/github/install' });
              return;
            }
            throw err;
          }
          repo = provisioned.fullName;
          pushed = provisioned.pushed;
          const made = await createProject(db, orgId, { name, repo, tier: 'personal' });
          if (!made.ok) {
            if (made.kind === 'limit') { refuse(res, made.allowance); return; }
            res.status(made.status).json({ error: `${made.error}. The complete source repo is safe at ${repo}; connect it as an existing repository to finish.`, repo });
            return;
          }
          projectId = made.pack.identity.project_id;
        }
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
