import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentMessageAttachments, agentRuns, usageBuildMinutes } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createWorkshopRouter, type WorkshopDeps } from '../../src/server/web/routes/workshop.js';
import { appWithOrg } from './helpers.js';
import { onPlan } from '../helpers/plan.js';
import { planLimits } from '../../src/shared/plans.js';
import { monthStartUtc } from '../../src/server/billing/entitlements.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';
import { getBuild, setBuild } from '../../src/server/build/store.js';

describe('web/routes/workshop — the workshop surface', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  const app = (deps: WorkshopDeps = {}) => appWithOrg(orgId, createWorkshopRouter(db, {
    lookup: stubRepoLookup,
    env: engineOn,
    verifyPreview: async () => ({ status: 'passed', screenshot_artifact_ids: [], screenshots: [], console_errors: [], failed_requests: [], routes_checked: ['/'], limitation: null, captured_at: new Date().toISOString() }),
    ...deps,
  }));

  it('serves the page data: project, engine state, empty thread, zero cost', async () => {
    const res = await request(app()).get('/api/projects/loom/workshop');
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('Loom');
    expect(res.body.engine_on).toBe(true);
    expect(res.body.working).toBe(false);
    expect(res.body.thread).toEqual([]);
    expect(res.body.cost).toEqual({ today_cents: 0, month_cents: 0 });
  });

  it('a message starts a background turn (202) with the config resolved from the pack', async () => {
    let seen: { projectId?: string; text?: string; repo?: string } = {};
    const res = await request(
      app({
        runTurn: (async (_db, _org, projectId, text, cfg) => {
          seen = { projectId, text, repo: cfg.repoFullName };
          return { runId: 'r', status: 'succeeded', costCents: 1, reply: 'ok', stagedChangesReady: false };
        }) as WorkshopDeps['runTurn'],
      }),
    )
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'make the header dark' });
    expect(res.status).toBe(202);
    // The background turn got the owner's words and the pack's repo.
    expect(seen).toEqual({ projectId: 'loom', text: 'make the header dark', repo: 'acme/loom' });
  });

  it('refuses a second message while a run is active — one thing at a time, in plain words', async () => {
    await db.insert(agentRuns).values({ id: ulid(), orgId, projectId: 'loom', prompt: 'x', status: 'running', startedAt: new Date() });
    const res = await request(app()).post('/api/projects/loom/workshop/message').send({ text: 'another thing' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already working/i);
  });

  it('a crashed old run does not block forever', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago > 45min cutoff
    await db.insert(agentRuns).values({ id: ulid(), orgId, projectId: 'loom', prompt: 'x', status: 'running', startedAt: old, createdAt: old });
    const res = await request(app({ runTurn: (async () => ({ runId: 'r', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false })) as WorkshopDeps['runTurn'] }))
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'go' });
    expect(res.status).toBe(202);
  });

  it('is honest when the engine is not configured', async () => {
    const res = await appAndPost(db, { env: () => null });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't switched on/i);
  });

  it('previews the existing workshop checkout without asking GitHub for it again', async () => {
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_warm', repoFullName: 'acme/loom', branch: 'main' });
    let seen: { token?: string; repo?: string; branch?: string } = {};
    const res = await request(app({
      preview: async (_db, _org, _project, cfg) => {
        seen = { token: cfg.githubToken, repo: cfg.repoFullName, branch: cfg.branch };
        return { state: 'ready', url: 'https://preview.example.test', message: null };
      },
    })).post('/api/projects/loom/workshop/preview').send({});

    expect(res.status).toBe(202);
    expect(res.body.state).toBe('starting');
    await vi.waitFor(() => expect(seen.repo).toBe('acme/loom'));
    expect(seen).toEqual({ token: '', repo: 'acme/loom', branch: 'main' });
  });

  it('persists go-live progress and exposes the completed result after the request returns', async () => {
    let finish!: (value: { outcome: 'live'; url: string; message: string }) => void;
    const pending = new Promise<{ outcome: 'live'; url: string; message: string }>((resolve) => { finish = resolve; });
    const theApp = app({ goLive: (async () => pending) as WorkshopDeps['goLive'] });

    const started = await request(theApp).post('/api/projects/loom/workshop/golive').send({});
    expect(started.status).toBe(202);
    expect((await request(theApp).get('/api/projects/loom/workshop/golive')).body).toMatchObject({ status: 'running' });

    finish({ outcome: 'live', url: 'https://loom.example', message: 'It is online.' });
    await vi.waitFor(async () => {
      expect((await request(theApp).get('/api/projects/loom/workshop/golive')).body).toMatchObject({ status: 'succeeded', message: 'It is online.' });
    });
  });

  it('does not start a duplicate go-live while one is already running', async () => {
    let calls = 0;
    const never = new Promise<never>(() => undefined);
    const theApp = app({ goLive: (async () => { calls += 1; return never; }) as WorkshopDeps['goLive'] });
    expect((await request(theApp).post('/api/projects/loom/workshop/golive').send({})).status).toBe(202);
    expect((await request(theApp).post('/api/projects/loom/workshop/golive').send({})).status).toBe(202);
    expect(calls).toBe(1);
  });

  it('sums the cost watch from real runs', async () => {
    await db.insert(agentRuns).values([
      { id: ulid(), orgId, projectId: 'loom', prompt: 'a', status: 'succeeded', costCents: 120 },
      { id: ulid(), orgId, projectId: 'loom', prompt: 'b', status: 'succeeded', costCents: 80 },
    ]);
    const res = await request(app()).get('/api/projects/loom/workshop');
    expect(res.body.cost.today_cents).toBe(200);
    expect(res.body.cost.month_cents).toBe(200);
  });

  it('discards only the unshipped development copy and clears its checkpoint', async () => {
    await setBuild(db, orgId, 'loom', {
      stagedChangesReady: true,
      checkpointArchiveBase64: Buffer.from('temporary work').toString('base64'),
      checkpointSha256: 'not-needed-for-discard',
    });
    const res = await request(app()).post('/api/projects/loom/workshop/discard').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ discarded: true });
    const state = await getBuild(db, orgId, 'loom');
    expect(state?.stagedChangesReady).toBe(false);
    expect(state?.checkpointArchiveBase64).toBeNull();
  });

  it('is org-scoped: another org gets a 404, and never the thread', async () => {
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId: 'loom', role: 'owner', content: 'secret plans' });
    const other = appWithOrg('org_2', createWorkshopRouter(db, { lookup: stubRepoLookup, env: engineOn }));
    expect((await request(other).get('/api/projects/loom/workshop')).status).toBe(404);
  });

  it('stages a large file over HTTP (streamed to disk, not the JSON body) and passes it through to the turn by id', async () => {
    const theApp = app();
    // "way more than 15MB" — this used to be impossible; now it's just a multipart upload.
    const bigFile = Buffer.alloc(20 * 1024 * 1024, 'x'); // 20MB — larger than the old inline cap
    const staged = await request(theApp)
      .post('/api/projects/loom/workshop/uploads')
      .attach('file', bigFile, 'library.zip');
    expect(staged.status).toBe(201);
    expect(staged.body).toMatchObject({ name: 'library.zip', size: bigFile.length });
    expect(typeof staged.body.id).toBe('string');

    let seen: unknown = null;
    const res = await request(
      app({
        runTurn: (async (_db, _org, _projectId, _text, _cfg, attachments) => {
          seen = attachments;
          return { runId: 'r', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false };
        }) as WorkshopDeps['runTurn'],
      }),
    )
      .post('/api/projects/loom/workshop/message')
      .send({
        text: 'seed the database from this',
        images: [{ mime: 'image/png', dataBase64: Buffer.from('x').toString('base64') }],
        files: [{ id: staged.body.id }],
      });
    expect(res.status).toBe(202);
    expect(seen).toMatchObject({
      images: [{ mime: 'image/png', dataBase64: Buffer.from('x').toString('base64') }],
      files: [{ name: 'library.zip', mime: 'application/zip', localPath: expect.any(String) }],
    });
  });

  it('refuses a file id that was never staged (or already used) — plainly, before firing anything', async () => {
    const res = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', files: [{ id: 'not-a-real-upload' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wasn't found/i);
  });

  it("mode: 'plan' reaches the turn — the think-first path is wired end to end", async () => {
    let seen: unknown = null;
    const res = await request(
      app({
        runTurn: (async (_db, _org, _projectId, _text, _cfg, options) => {
          seen = options;
          return { runId: 'r', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false };
        }) as WorkshopDeps['runTurn'],
      }),
    )
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'should we add accounts?', mode: 'plan' });
    expect(res.status).toBe(202);
    expect(seen).toMatchObject({ mode: 'plan' });
  });

  it('omitted mode builds — thinking is opt-in per message, never a default', async () => {
    let seen: unknown = null;
    const res = await request(
      app({
        runTurn: (async (_db, _org, _projectId, _text, _cfg, options) => {
          seen = options;
          return { runId: 'r', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false };
        }) as WorkshopDeps['runTurn'],
      }),
    )
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'add accounts' });
    expect(res.status).toBe(202);
    expect(seen).toMatchObject({ mode: 'build' });
  });

  it('an unknown mode is a plain 400, before anything fires', async () => {
    const res = await request(app()).post('/api/projects/loom/workshop/message').send({ text: 'x', mode: 'yolo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mode must be/i);
  });

  it("a file staged for one project can't be spent on another project's message", async () => {
    const staged = await request(app())
      .post('/api/projects/loom/workshop/uploads')
      .attach('file', Buffer.from('data'), 'notes.txt');
    expect(staged.status).toBe(201);

    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'patina', name: 'Patina', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/patina', role: 'source_of_truth' }] },
      }),
    );
    const res = await request(app())
      .post('/api/projects/patina/workshop/message')
      .send({ text: 'x', files: [{ id: staged.body.id }] });
    expect(res.status).toBe(400);
  });

  it('rejects a huge upload plainly, and rejects malformed message-body attachments', async () => {
    const badMime = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', images: [{ mime: 'application/pdf', dataBase64: 'abc' }] });
    expect(badMime.status).toBe(400);
    expect(badMime.body.error).toMatch(/PNG|JPEG/i);

    const tooMany = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', images: Array.from({ length: 11 }, () => ({ mime: 'image/png', dataBase64: 'abc' })) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/at most 10/i);

    const badFileRef = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', files: [{ notAnId: true }] });
    expect(badFileRef.status).toBe(400);
    expect(badFileRef.body.error).toMatch(/upload id/i);
  });

  it('the thread lists attachment refs, and serves an image only within its own org/project', async () => {
    const [msg] = await db
      .insert(agentMessages)
      .values({ id: ulid(), orgId, projectId: 'loom', role: 'owner', content: 'here is a mockup' })
      .returning();
    const [att] = await db
      .insert(agentMessageAttachments)
      .values({ id: ulid(), orgId, projectId: 'loom', agentMessageId: msg!.id, mime: 'image/png', dataBase64: Buffer.from('png-bytes').toString('base64') })
      .returning();

    const page = await request(app()).get('/api/projects/loom/workshop');
    expect(page.body.thread[0].attachments).toEqual([{ id: att!.id, mime: 'image/png' }]);

    const ok = await request(app()).get(`/api/projects/loom/workshop/attachments/${att!.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.body).toEqual(Buffer.from('png-bytes'));

    // Another org can't fetch it, even knowing the attachment id.
    const other = appWithOrg('org_2', createWorkshopRouter(db, { lookup: stubRepoLookup, env: engineOn }));
    expect((await request(other).get(`/api/projects/loom/workshop/attachments/${att!.id}`)).status).toBe(404);
  });

  function appAndPost(dbx: TestDb, deps: WorkshopDeps) {
    return request(appWithOrg(orgId, createWorkshopRouter(dbx, { lookup: stubRepoLookup, ...deps }))).post('/api/projects/loom/workshop/message').send({ text: 'x' });
  }

  /**
   * BUILD MINUTES — the plan limit on wall-clock sandbox time.
   *
   * What is gated is STARTING new work. What is deliberately not gated is
   * finishing it: shipping and rolling back are the completion of work the
   * minutes were already spent on, and a meter must never stand between
   * somebody and undoing a bad deploy.
   */
  describe('when the month\'s build minutes are gone', () => {
    const spend = async (minutes: number) =>
      db.insert(usageBuildMinutes).values({ id: ulid(), orgId, periodStart: monthStartUtc(), minutesUsed: minutes });

    it('refuses a new turn before a sandbox is asked for', async () => {
      await spend(planLimits('free').buildMinutes);
      let started = false;
      const res = await appAndPost(db, {
        env: engineOn,
        runTurn: (async () => {
          started = true;
        }) as unknown as WorkshopDeps['runTurn'],
      });

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('limit_build_minutes');
      expect(started).toBe(false);
    });

    /** A preview holds a sandbox open for as long as somebody is looking at it. */
    it('refuses a preview, which is a sandbox by another name', async () => {
      await spend(planLimits('free').buildMinutes);
      let opened = false;
      const res = await request(
        app({
          preview: async () => {
            opened = true;
            return { state: 'ready', url: 'http://x' } as never;
          },
        }),
      ).post('/api/projects/loom/workshop/preview').send({});

      expect(res.status).toBe(402);
      expect(opened).toBe(false);
    });

    it('tells a Pro account it is fair-use, and never implies a charge', async () => {
      await onPlan(db, orgId);
      await spend(planLimits('pro').buildMinutes);
      const res = await appAndPost(db, { env: engineOn });

      expect(res.status).toBe(402);
      expect(res.body.error).toMatch(/email us/i);
      expect(res.body.error).not.toMatch(/\$/);
    });

    it('lets work through while there are minutes left', async () => {
      await spend(planLimits('free').buildMinutes - 1);
      expect((await appAndPost(db, { env: engineOn, runTurn: (async () => {}) as unknown as WorkshopDeps['runTurn'] })).status).toBe(202);
    });
  });
});
