import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, agentMessages, agentMessageAttachments, agentRuns } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createWorkshopRouter, type WorkshopDeps } from '../../src/server/web/routes/workshop.js';
import { appWithOrg } from './helpers.js';

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

  const app = (deps: WorkshopDeps = {}) => appWithOrg(orgId, createWorkshopRouter(db, { env: engineOn, ...deps }));

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

  it('sums the cost watch from real runs', async () => {
    await db.insert(agentRuns).values([
      { id: ulid(), orgId, projectId: 'loom', prompt: 'a', status: 'succeeded', costCents: 120 },
      { id: ulid(), orgId, projectId: 'loom', prompt: 'b', status: 'succeeded', costCents: 80 },
    ]);
    const res = await request(app()).get('/api/projects/loom/workshop');
    expect(res.body.cost.today_cents).toBe(200);
    expect(res.body.cost.month_cents).toBe(200);
  });

  it('is org-scoped: another org gets a 404, and never the thread', async () => {
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId: 'loom', role: 'owner', content: 'secret plans' });
    const other = appWithOrg('org_2', createWorkshopRouter(db, { env: engineOn }));
    expect((await request(other).get('/api/projects/loom/workshop')).status).toBe(404);
  });

  it('passes attached images and files through to the turn', async () => {
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
        text: 'match this mockup',
        images: [{ mime: 'image/png', dataBase64: Buffer.from('x').toString('base64') }],
        files: [{ name: 'notes.md', dataBase64: Buffer.from('y').toString('base64') }],
      });
    expect(res.status).toBe(202);
    expect(seen).toEqual({
      images: [{ mime: 'image/png', dataBase64: Buffer.from('x').toString('base64') }],
      files: [{ name: 'notes.md', dataBase64: Buffer.from('y').toString('base64') }],
    });
  });

  it('rejects an attachment that fails the plain checks — bad mime, oversize, too many', async () => {
    const bigCsv = Buffer.alloc(16 * 1024 * 1024, 'x').toString('base64'); // over the 15MB file cap
    const tooBig = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', files: [{ name: 'huge.csv', dataBase64: bigCsv }] });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toMatch(/over/i);

    const badMime = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', images: [{ mime: 'application/pdf', dataBase64: 'abc' }] });
    expect(badMime.status).toBe(400);
    expect(badMime.body.error).toMatch(/PNG|JPEG/i);

    const tooMany = await request(app())
      .post('/api/projects/loom/workshop/message')
      .send({ text: 'x', images: Array.from({ length: 5 }, () => ({ mime: 'image/png', dataBase64: 'abc' })) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/at most 4/i);
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
    const other = appWithOrg('org_2', createWorkshopRouter(db, { env: engineOn }));
    expect((await request(other).get(`/api/projects/loom/workshop/attachments/${att!.id}`)).status).toBe(404);
  });

  function appAndPost(dbx: TestDb, deps: WorkshopDeps) {
    return request(appWithOrg(orgId, createWorkshopRouter(dbx, deps))).post('/api/projects/loom/workshop/message').send({ text: 'x' });
  }
});
