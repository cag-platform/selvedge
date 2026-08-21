import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, digests, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { createThread, ensureWorkshopThread, getThread, listThreads } from '../../src/server/threads/store.js';
import { setBuild } from '../../src/server/build/store.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/threads — the Inbox surface', () => {
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
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  const app = (deps: ThreadsDeps = {}) => appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, ...deps }));

  it('the rail: every project with its edge, its threads newest-first, and the brief pinned', async () => {
    const first = await ensureWorkshopThread(db, orgId, 'loom');
    const second = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });
    await db.insert(agentMessages).values([
      { id: ulid(), orgId, projectId: 'loom', threadId: first.id, role: 'owner', content: 'old', createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: ulid(), orgId, projectId: 'loom', threadId: second.id, role: 'owner', content: 'new', createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    await db.insert(digests).values({
      id: ulid(),
      orgId,
      digestDate: new Date().toISOString().slice(0, 10),
      headline: 'A quiet night — nothing needs you.',
      sections: {},
      openThreads: [],
      renderedText: 'x',
    });

    const res = await request(app()).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    const project = res.body.projects[0];
    expect(project.name).toBe('Loom');
    expect(project.status).toBeTruthy(); // the edge a stranger reads health from
    expect(project.threads.map((t: { title: string }) => t.title)).toEqual(['Pricing', 'Workshop']);
    // Each row carries its agent's mono mark — identity as text, never colour.
    expect(project.threads[0].chip).toBe('CL');
    expect(project.threads[1].chip).toBe('CC');
    expect(res.body.brief.headline).toBe('A quiet night — nothing needs you.');
    expect(res.body.unsorted_count).toBe(0);
  });

  it('an archived thread drops off the rail without being deleted', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await request(app()).patch(`/api/threads/${thread.id}`).send({ archived: true }).expect(200);
    const res = await request(app()).get('/api/inbox');
    expect(res.body.projects[0].threads).toHaveLength(0);
    expect(await listThreads(db, orgId, 'loom', { includeArchived: true })).toHaveLength(1);
  });

  it('a thread serves its whole conversation, its runs, and what it has cost', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'owner', content: 'make it dark' });
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'make it dark',
      status: 'succeeded',
      costCents: 18,
    });

    const res = await request(app()).get(`/api/threads/${thread.id}`);
    expect(res.status).toBe(200);
    expect(res.body.thread).toMatchObject({ id: thread.id, kind: 'workshop', agent: 'claude-code', title: 'Workshop' });
    expect(res.body.project.name).toBe('Loom');
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ kind: 'turn', agent: 'claude-code', cost_cents: 18 });
    expect(res.body.cost_cents).toBe(18);
    expect(res.body.engine_on).toBe(true);
  });

  it('is org-scoped: another org cannot read a thread, or even learn it exists', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const otherOrg = appWithOrg('org_2', createThreadsRouter(db, { env: engineOn }));
    expect((await request(otherOrg).get(`/api/threads/${thread.id}`)).status).toBe(404);
    expect((await request(otherOrg).patch(`/api/threads/${thread.id}`).send({ title: 'mine now' })).status).toBe(400);
    expect((await request(otherOrg).post(`/api/threads/${thread.id}/message`).send({ text: 'hi' })).status).toBe(404);
    expect((await getThread(db, orgId, thread.id))!.title).toBe('Workshop');
  });

  it('starts a new thread of either kind, and refuses an agent that cannot run it', async () => {
    const workshop = await request(app()).post('/api/projects/loom/threads').send({ kind: 'workshop', title: 'Checkout rework' });
    expect(workshop.status).toBe(201);
    expect(workshop.body.thread).toMatchObject({ kind: 'workshop', agent: 'claude-code', title: 'Checkout rework' });

    const general = await request(app()).post('/api/projects/loom/threads').send({ kind: 'general' });
    expect(general.body.thread).toMatchObject({ kind: 'general', agent: 'claude' });

    const wrong = await request(app()).post('/api/projects/loom/threads').send({ kind: 'workshop', agent: 'gpt' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/can't run a workshop thread/i);
    expect((await request(app()).post('/api/projects/nope/threads').send({})).status).toBe(404);
  });

  it('renames a thread, and refuses to leave one nameless', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await request(app()).patch(`/api/threads/${thread.id}`).send({ title: 'Checkout rework' }).expect(200);
    expect((await getThread(db, orgId, thread.id))!.title).toBe('Checkout rework');
    await request(app()).patch(`/api/threads/${thread.id}`).send({ title: '   ' }).expect(400);
  });

  it('switching the agent answers with the line the thread will show', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const res = await request(app()).patch(`/api/threads/${thread.id}`).send({ agent: 'codex' });
    expect(res.status).toBe(200);
    expect(res.body.switched).toBe(true);
    expect(res.body.thread.agent).toBe('codex');
    expect(res.body.line).toContain('continued with Codex');
    expect(res.body.handoff_tokens).toBeGreaterThan(0);

    const refused = await request(app()).patch(`/api/threads/${thread.id}`).send({ agent: 'gpt' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/sandbox/i);
  });

  it('a workshop message starts a build turn, carrying the thread and any parked handoff', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
    await request(app()).patch(`/api/threads/${thread.id}`).send({ agent: 'codex' }).expect(200);

    let seen: Record<string, unknown> = {};
    const res = await request(
      app({
        runTurn: (async (_db, _org, projectId, text, cfg, options) => {
          seen = { projectId, text, agent: cfg.agent, handoff: options?.handoff, threadId: options?.threadId };
          return { runId: 'r', agent: 'codex', status: 'succeeded', costCents: 1, reply: 'ok', stagedChangesReady: false };
        }) as ThreadsDeps['runTurn'],
      }),
    )
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: 'now finish the checkout' });

    expect(res.status).toBe(202);
    expect(seen.projectId).toBe('loom');
    expect(seen.agent).toBe('codex');
    expect(seen.threadId).toBe(thread.id);
    // The incoming agent starts with the handover, not cold.
    expect(String(seen.handoff)).toContain('Loom');
    // Spent once: the next message starts clean.
    const second = await request(
      app({
        runTurn: (async (_db, _org, _p, _t, _cfg, options) => {
          seen = { handoff: options?.handoff };
          return { runId: 'r2', agent: 'codex', status: 'succeeded', costCents: 1, reply: 'ok', stagedChangesReady: false };
        }) as ThreadsDeps['runTurn'],
      }),
    )
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: 'and the footer' });
    expect(second.status).toBe(202);
    expect(seen.handoff).toBeUndefined();
  });

  it('a general message runs a chat turn instead, with no sandbox anywhere near it', async () => {
    const chat = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });
    let seen = '';
    const res = await request(
      app({
        chatTurn: (async (_db, _org, thread, text) => {
          seen = `${thread.id}:${text}`;
          return { ok: true, reply: 'sure', model: 'claude-sonnet-5', costed: true };
        }) as ThreadsDeps['chatTurn'],
      }),
    )
      .post(`/api/threads/${chat.id}/message`)
      .send({ text: 'should we do subscriptions?' });
    expect(res.status).toBe(202);
    expect(seen).toBe(`${chat.id}:should we do subscriptions?`);
  });

  it('says when a cold workshop has to warm up, rather than looking stuck', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const cold = await request(
      app({ runTurn: (async () => ({ runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: '', stagedChangesReady: false })) as ThreadsDeps['runTurn'] }),
    )
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: 'hello' });
    expect(cold.body).toMatchObject({ started: true, warming: true });

    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
    const warm = await request(
      app({ runTurn: (async () => ({ runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: '', stagedChangesReady: false })) as ThreadsDeps['runTurn'] }),
    )
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: 'hello again' });
    expect(warm.body.warming).toBe(false);
  });

  it('refuses an empty message, and a second one while the project is already working', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: '  ' }).expect(400);

    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      prompt: 'working',
      status: 'running',
      startedAt: new Date(),
    });
    const busy = await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'and another' });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/already working/i);
  });

  it('is honest when the engine is not configured', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const off = appWithOrg(orgId, createThreadsRouter(db, { env: () => null }));
    const res = await request(off).post(`/api/threads/${thread.id}/message`).send({ text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't switched on/i);
    expect((await request(off).get('/api/inbox')).body.engine_on).toBe(false);
  });
});
