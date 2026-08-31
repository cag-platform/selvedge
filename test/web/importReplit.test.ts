import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { zipSync } from 'fflate';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { migrationJourneys, migrationTestInputs, orgs } from '../../src/server/db/schema/index.js';
import { createImportReplitRouter } from '../../src/server/web/routes/importReplit.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { GithubError } from '../../src/server/connectors/github/newRepo.js';
import { appWithOrg } from './helpers.js';
import { setBuild } from '../../src/server/build/store.js';

/**
 * THE MIGRATION DOOR: a Repl zip in, a project around a repo the owner
 * controls out. The properties held here are the door's, not GitHub's — repo
 * creation and the push are injected, because what must be true is the
 * ordering (validate before creating, plan gate before repo), the half-state
 * honesty when a push fails after a repo exists, and the retry that layers
 * instead of duplicating.
 */
describe('web/routes/import/replit', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const originalCredentialKey = process.env.CREDENTIALS_KEY;

  const enc = (s: string) => new TextEncoder().encode(s);
  const goodZip = () => Buffer.from(zipSync({ 'my-repl/index.js': enc('console.log(1)'), 'my-repl/node_modules/x.js': enc('junk') }));

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'route-test-credentials-key-that-is-at-least-32-characters';
    await db.insert(orgs).values([{ orgId, plan: 'studio' }]);
  });
  afterEach(async () => { if (originalCredentialKey === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = originalCredentialKey; await close(); });

  const pushes: Array<{ repo: string; files: string[]; message: string }> = [];
  const okPush = async (repo: string, files: Array<{ path: string }>, message: string) => {
    pushes.push({ repo, files: files.map((f) => f.path), message });
    return { commitSha: 'c0ffee', branch: 'main', files: files.length };
  };
  const okCreateRepo = async (_orgId: string, name: string) => ({ fullName: `acme/${name}` });

  const app = (deps = {}) =>
    appWithOrg(orgId, createImportReplitRouter(db, { createRepo: okCreateRepo, push: okPush, prepareWorkspace: async () => ({ ok: true, workspaceId: 'ws_migration' }), startPreview: async () => ({ state: 'ready', url: 'https://preview.example', message: null }), verifyPreview: async () => ({ schema_version: 1, status: 'passed', verifier: 'selvedge-preview-verifier', independent_from_migration_agent: true, checks: [{ name: 'Preview responds', status: 'passed', detail: 'HTTP 200' }], screenshot_artifact_ids: [], screenshot_artifacts: [], console_errors: [], failed_requests: [], routes_checked: [], guided_journey: { status: 'passed', name: 'Test', steps: [] }, limitations: [], verified_at: new Date().toISOString() }), ...deps }));

  const send = (a = app(), fields: Record<string, string> = { name: 'Loom Shop' }) => {
    let req = request(a).post('/api/import/replit');
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', goodZip(), 'repl.zip');
  };

  it('zip → repo → project → workshop, with the junk named', async () => {
    pushes.length = 0;
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe('loom-shop');
    expect(res.body.repo).toBe('acme/loom-shop');
    expect(res.body.thread_id).toBeTruthy();
    expect(res.body.skipped).toEqual(['node_modules']);
    expect(res.body.summary).toContain('node_modules');
    expect(res.body.migration_plan.steps.map((step: { id: string }) => step.id)).toEqual(['inspect', 'connect', 'workspace', 'configure', 'preview', 'verify', 'ship']);
    // The junk never reached the push, and the app did.
    expect(pushes[0]!.files).toEqual(['index.js']);
    expect(pushes[0]!.message).toBe('Imported from Replit');
    // And the project genuinely exists, pointed at the minted repo.
    const pack = await getPack(db, orgId, 'loom-shop');
    expect(pack?.topology.sources.some((s) => s.connector === 'github' && s.resource_id === 'acme/loom-shop')).toBe(true);
  });

  it('turns an installed GitHub repository into a guided migration journey', async () => {
    const started = await request(app({ inspectGithubRepo: async () => ({ defaultBranch: 'main', truncated: false, files: [
      { path: 'package.json', bytes: new TextEncoder().encode('{"dependencies":{"next":"15.0.0","stripe":"1.0.0"}}') },
      { path: 'src/app.tsx', bytes: new TextEncoder().encode('const key = process.env.STRIPE_SECRET_KEY') },
    ] }) })).post('/api/import/github').send({ repo: 'acme/loom-shop', source: 'cursor' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ repo: 'acme/loom-shop', default_branch: 'main' });
    expect(started.body.project_map.stack).toContain('Next.js');
    expect(started.body.thread_id).toBeTruthy();
    const [journey] = await db.select().from(migrationJourneys);
    expect(journey).toMatchObject({ source: 'cursor', projectId: started.body.project_id, originalUntouched: true, state: 'mapped' });
    expect((journey?.destinations as Record<string, string>).repository).toBe('acme/loom-shop');
    const loaded = await request(app()).get(`/api/projects/${started.body.project_id}/migration`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.migration_plan.steps[0]).toMatchObject({ id: 'inspect', state: 'complete' });
  });

  it('refuses an unrecognized GitHub migration source before inspection', async () => {
    let inspected = false;
    const result = await request(app({ inspectGithubRepo: async () => { inspected = true; return { defaultBranch: 'main', truncated: false, files: [] }; } })).post('/api/import/github').send({ repo: 'acme/loom-shop', source: 'replit' });
    expect(result.status).toBe(400);
    expect(inspected).toBe(false);
  });

  it('records neutral destination intent without provisioning anything', async () => {
    await send();
    const selected = await request(app()).patch('/api/projects/loom-shop/migration/destinations').send({ hosting: 'railway', database: 'neon' });
    expect(selected.status).toBe(200);
    expect(selected.body.destinations).toMatchObject({ repository: 'acme/loom-shop', hosting: 'railway', database: 'neon' });
    expect(selected.body.original_untouched).toBe(true);
    expect(selected.body.migration_plan.steps.find((step: { id: string }) => step.id === 'ship').state).toBe('blocked');
    const rejected = await request(app()).patch('/api/projects/loom-shop/migration/destinations').send({ hosting: 'mystery', database: 'neon' });
    expect(rejected.status).toBe(400);
  });

  it('prepares one native workspace and persists the migration transition', async () => {
    await send();
    let preparations = 0;
    const prepared = await request(app({ prepareWorkspace: async () => { preparations += 1; return { ok: true, workspaceId: 'ws_1' }; } })).post('/api/projects/loom-shop/migration/workspace');
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ workspace_id: 'ws_1', state: 'preview_ready', preview: { state: 'ready', url: 'https://preview.example' }, original_untouched: true });
    expect(prepared.body.migration_plan.steps.find((step: { id: string }) => step.id === 'workspace').state).toBe('complete');
    expect(preparations).toBe(1);
  });

  it('persists preview diagnosis for the migration agent and owner', async () => {
    await send();
    const attempted = await request(app({ startPreview: async () => ({ state: 'error', url: null, message: 'The app needs STRIPE_SECRET_KEY.', offer: 'env' }) })).post('/api/projects/loom-shop/migration/workspace');
    expect(attempted.status).toBe(200);
    expect(attempted.body.state).toBe('copying');
    expect(attempted.body.migration_plan.steps.find((step: { id: string }) => step.id === 'preview').blockers).toEqual(['The app needs STRIPE_SECRET_KEY.']);
    const journey = await request(app()).get('/api/projects/loom-shop/migration');
    expect(journey.body.preview).toMatchObject({ state: 'error', message: 'The app needs STRIPE_SECRET_KEY.' });
  });

  it('runs an independent verifier and only then unlocks owner approval', async () => {
    await send();
    await request(app()).post('/api/projects/loom-shop/migration/workspace');
    await setBuild(db, orgId, 'loom-shop', { previewUrl: 'https://preview.example' });
    const verified = await request(app()).post('/api/projects/loom-shop/migration/verify');
    expect(verified.status).toBe(200);
    expect(verified.body.state).toBe('verified');
    expect(verified.body.verification).toMatchObject({ status: 'passed', independent_from_migration_agent: true });
    expect(verified.body.migration_plan.steps.find((step: { id: string }) => step.id === 'verify').state).toBe('complete');
    expect(verified.body.migration_plan.steps.find((step: { id: string }) => step.id === 'ship').state).toBe('blocked');
    const destination = await request(app()).patch('/api/projects/loom-shop/migration/destinations').send({ hosting: 'railway', database: 'neon' });
    expect(destination.body.migration_plan.steps.find((step: { id: string }) => step.id === 'ship').state).toBe('approval_required');
  });

  it('stores tenant-scoped desktop and mobile browser evidence', async () => {
    await send();
    await request(app()).post('/api/projects/loom-shop/migration/workspace');
    await setBuild(db, orgId, 'loom-shop', { previewUrl: 'https://preview.example' });
    const stored: string[] = [];
    const evidenceApp = app({
      captureBrowserEvidence: async () => ({ screenshots: [
        { id: 'desktop-home', route: '/', bytes: new Uint8Array([1]), mime: 'image/png', width: 1440, height: 1000 },
        { id: 'mobile-home', route: '/', bytes: new Uint8Array([2]), mime: 'image/png', width: 390, height: 844 },
      ], consoleErrors: [], failedRequests: [], routesChecked: ['/'], guidedJourney: { status: 'passed', name: 'Open navigation', steps: [{ label: 'Menu', intent: 'Reveal navigation', outcome: 'passed', detail: 'The control responded.' }] }, error: null }),
      visualStore: {
        put: async (key: string) => { stored.push(key); },
        signedGet: async (key: string) => `https://evidence.example/${encodeURIComponent(key)}`,
        delete: async () => undefined,
      },
    });
    const verified = await request(evidenceApp).post('/api/projects/loom-shop/migration/verify');
    expect(verified.body.verification.status).toBe('passed');
    expect(verified.body.verification.screenshot_artifact_ids).toHaveLength(2);
    expect(stored).toHaveLength(2);
    const screenshot = await request(evidenceApp).get(`/api/projects/loom-shop/migration/screenshots/${verified.body.verification.screenshot_artifact_ids[0]}`);
    expect(screenshot.status).toBe(302);
    expect(screenshot.headers.location).toContain('evidence.example');
    const missing = await request(evidenceApp).get('/api/projects/loom-shop/migration/screenshots/not-owned');
    expect(missing.status).toBe(404);
  });

  it('persists an owner-defined test plan and explicit approval boundary', async () => {
    await send();
    const createdAt = new Date('2026-08-29T00:00:00Z').toISOString();
    const planned = await request(app({ planOwnerTestFlow: async (_db: unknown, _orgId: string, goal: string) => ({ schema_version: 1, goal, status: 'approval_required', steps: [
      { id: 'step_view', label: 'Open dashboard', detail: 'View the dashboard.', boundary: 'automatic', state: 'ready', result_detail: null, evidence_artifact_ids: [] },
      { id: 'step_create', label: 'Create draft', detail: 'Submit the draft form in the development copy.', boundary: 'approval_required', state: 'pending', result_detail: null, evidence_artifact_ids: [], input_requirements: [{ id: 'project_name', label: 'Test project name', input_type: 'text', kind: 'synthetic' }] },
    ], created_at: createdAt, updated_at: createdAt }) })).post('/api/projects/loom-shop/migration/test-flow').send({ goal: 'Create a draft project' });
    expect(planned.status).toBe(200);
    expect(planned.body.test_flow).toMatchObject({ status: 'approval_required', goal: 'Create a draft project' });
    expect(planned.body.migration_plan.steps.find((step: { id: string }) => step.id === 'ship').blockers).toContain('The owner-defined test flow must pass before shipping.');
    const refused = await request(app()).put('/api/projects/loom-shop/migration/test-flow/step_create/inputs').send({ values: { project_name: 'Test draft' } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('Production credentials are refused');
    const storedInput = await request(app()).put('/api/projects/loom-shop/migration/test-flow/step_create/inputs').send({ values: { project_name: 'Test draft' }, declared_non_production: true, production: false });
    expect(storedInput.status).toBe(200);
    expect(JSON.stringify(storedInput.body)).not.toContain('Test draft');
    expect(storedInput.body.test_flow.steps.find((step: { id: string }) => step.id === 'step_create').input_requirements[0].configured).toBe(true);
    const approved = await request(app()).post('/api/projects/loom-shop/migration/test-flow/step_create/approve').send({});
    expect(approved.status).toBe(200);
    expect(approved.body.test_flow).toMatchObject({ status: 'ready' });
    expect(approved.body.test_flow.steps.find((step: { id: string }) => step.id === 'step_create').state).toBe('approved');
    const duplicate = await request(app()).post('/api/projects/loom-shop/migration/test-flow/step_create/approve').send({});
    expect(duplicate.status).toBe(409);

    await setBuild(db, orgId, 'loom-shop', { previewUrl: 'https://preview.example' });
    const evidenceApp = app({
      executeOwnerTestFlow: async (_orgId: string, _url: string, flow: { steps: Array<Record<string, unknown>> }) => ({ flow: { ...flow, status: 'passed', steps: flow.steps.map((step) => ({ ...step, state: 'passed', result_detail: 'An observable preview change was recorded.' })), updated_at: new Date().toISOString() }, screenshots: [{ stepId: 'step_view', route: '/dashboard', bytes: new Uint8Array([1]), mime: 'image/png' }] }),
      visualStore: { put: async () => undefined, signedGet: async (key: string) => `https://evidence.example/${encodeURIComponent(key)}`, delete: async () => undefined },
    });
    const ran = await request(evidenceApp).post('/api/projects/loom-shop/migration/test-flow/run').send({});
    expect(ran.status).toBe(200);
    expect(ran.body.test_flow.status).toBe('passed');
    expect(await db.select().from(migrationTestInputs)).toEqual([]);
    expect(ran.body.test_flow.steps.find((step: { id: string }) => step.id === 'step_view').evidence_artifact_ids).toHaveLength(1);
    expect(ran.body.migration_plan.steps.find((step: { id: string }) => step.id === 'ship').blockers).not.toContain('The owner-defined test flow must pass before shipping.');
    const artifactId = ran.body.test_flow.steps.find((step: { id: string }) => step.id === 'step_view').evidence_artifact_ids[0];
    expect((await request(evidenceApp).get(`/api/projects/loom-shop/migration/screenshots/${artifactId}`)).status).toBe(302);
  });

  it('persists an actionable blocker when workspace preparation cannot start', async () => {
    await send();
    const failed = await request(app({ prepareWorkspace: async () => ({ ok: false, status: 409, error: 'Connect GitHub again.' }) })).post('/api/projects/loom-shop/migration/workspace');
    expect(failed.status).toBe(409);
    expect(failed.body.migration_plan.steps.find((step: { id: string }) => step.id === 'workspace').blockers).toEqual(['Connect GitHub again.']);
    const journey = await request(app()).get('/api/projects/loom-shop/migration');
    expect(journey.body.migration_plan.steps.find((step: { id: string }) => step.id === 'workspace').state).toBe('blocked');
  });

  /**
   * The half-state, said exactly. A repo was minted, files did not land —
   * "it failed" here costs an hour of confusion; the response names the
   * project and says the retry is safe.
   */
  it('a push failure after the repo exists names the project and the way through', async () => {
    const res = await send(
      app({
        push: async () => {
          throw new GithubError('GitHub responded 502');
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(res.body.project_id).toBe('loom-shop');
    expect(res.body.error).toContain('files did not land');
    expect(res.body.error).toContain('loom-shop');
  });

  it('pushes into an existing project instead of minting a second one', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    pushes.length = 0;
    const res = await send(app(), { project_id: 'loom' });
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe('loom');
    expect(pushes[0]!.repo).toBe('acme/loom');
  });

  it('a bad zip is refused before anything is created', async () => {
    let made = false;
    const a = app({
      createRepo: async () => {
        made = true;
        return { fullName: 'acme/x' };
      },
    });
    const res = await request(a)
      .post('/api/import/replit')
      .field('name', 'X')
      .attach('file', Buffer.from('not a zip'), 'repl.zip');
    expect(res.status).toBe(400);
    expect(made).toBe(false);
  });

  it('demands exactly one of a name or a project', async () => {
    expect((await send(app(), {})).status).toBe(400);
    expect((await send(app(), { name: 'X', project_id: 'loom' })).status).toBe(400);
  });

  it('a project with no repo cannot be pushed into, and says so', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({ identity: { project_id: 'bare', name: 'Bare', owner_description: 'x' }, topology: { sources: [] } }),
    );
    const res = await send(app(), { project_id: 'bare' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no GitHub repo');
  });
});
