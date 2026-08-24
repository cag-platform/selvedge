import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { eq, and } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, digests, orgs, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { createThread, createSubjectThread, ensureWorkshopThread, getThread, listThreads } from '../../src/server/threads/store.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { setBuild } from '../../src/server/build/store.js';
import { appWithOrg } from './helpers.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';

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

  const app = (deps: ThreadsDeps = {}) => appWithOrg(orgId, createThreadsRouter(db, { lookup: stubRepoLookup, env: engineOn, ...deps }));

  it('the rail: every project with its threads newest-first', async () => {
    const first = await ensureWorkshopThread(db, orgId, 'loom');
    const second = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });
    await db.insert(agentMessages).values([
      { id: ulid(), orgId, projectId: 'loom', threadId: first.id, role: 'owner', content: 'old', createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: ulid(), orgId, projectId: 'loom', threadId: second.id, role: 'owner', content: 'new', createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);

    const res = await request(app()).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    const project = res.body.projects[0];
    expect(project.name).toBe('Loom');
    expect(project.threads.map((t: { title: string }) => t.title)).toEqual(['Pricing', 'Workshop']);
    // Each row carries its agent's mono mark — identity as text, never colour.
    expect(project.threads[0].chip).toBe('CL');
    expect(project.threads[1].chip).toBe('CC');
  });

  /**
   * "I looked and couldn't tell" and "nothing has ever reported" are different
   * facts, and the rail used to say the second in the words of the first —
   * every project wearing a dashed edge under "No health signal yet.". Eight
   * rows of that reads as eight problems rather than one absence, and an alarm
   * that is always on stops being read.
   *
   * The dashed edge is the false-calm guard. It is spent on a project Selvedge
   * looked at and could not vouch for, and on nothing else.
   */
  it('says nothing about a project nothing has reported on — no edge, no line', async () => {
    const res = await request(app()).get('/api/inbox').expect(200);
    const project = res.body.projects[0];
    expect(project.status).toBeNull();
    expect(project.health).toBeNull();
  });

  it('but still wears the edge the moment there is something to say', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'sild', name: 'SILD', owner_description: 'A shop.' },
        state: { serving_now: { healthy: false } },
      }),
    );

    const res = await request(app()).get('/api/inbox').expect(200);
    const sild = res.body.projects.find((p: { id: string }) => p.id === 'sild');
    expect(sild.status).toBe('needs');
    expect(sild.health).toMatch(/down/i);

    // And the silent one beside it stays silent — the rule is per project, not
    // a global switch that one signal flips for everybody.
    const loom = res.body.projects.find((p: { id: string }) => p.id === 'loom');
    expect(loom.status).toBeNull();
  });

  /**
   * The rail carried a brief headline and an unsorted count. The brief is
   * retired; filing what Selvedge has seen is settings work. Neither is looked
   * up any more — a payload nobody reads is still a query somebody pays for,
   * and a rail that quietly kept computing them would drift back into use.
   */
  it('carries no brief line and no unsorted count — both left the rail', async () => {
    await db.insert(digests).values({
      id: ulid(),
      orgId,
      digestDate: new Date().toISOString().slice(0, 10),
      headline: 'A quiet night — nothing needs you.',
      sections: {},
      openThreads: [],
      renderedText: 'x',
    });

    const res = await request(app()).get('/api/inbox').expect(200);
    expect(res.body.brief).toBeUndefined();
    expect(res.body.unsorted_count).toBeUndefined();
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
    const otherOrg = appWithOrg('org_2', createThreadsRouter(db, { lookup: stubRepoLookup, env: engineOn }));
    expect((await request(otherOrg).get(`/api/threads/${thread.id}`)).status).toBe(404);
    expect((await request(otherOrg).patch(`/api/threads/${thread.id}`).send({ title: 'mine now' })).status).toBe(400);
    expect((await request(otherOrg).post(`/api/threads/${thread.id}/message`).send({ text: 'hi' })).status).toBe(404);
    expect((await getThread(db, orgId, thread.id))!.title).toBe('Workshop');
  });

  it('starts a conversation on whoever was asked for, and only balks at an agent nobody declared', async () => {
    const workshop = await request(app()).post('/api/projects/loom/threads').send({ kind: 'workshop', title: 'Checkout rework' });
    expect(workshop.status).toBe(201);
    expect(workshop.body.thread).toMatchObject({ kind: 'workshop', agent: 'claude-code', title: 'Checkout rework' });

    const general = await request(app()).post('/api/projects/loom/threads').send({ kind: 'general' });
    expect(general.body.thread).toMatchObject({ kind: 'general', agent: 'claude' });

    // Any agent may start any conversation. The pairing below used to be
    // refused outright; there is nothing incoherent about it, and the turn
    // itself decides what actually happens.
    const anyAgent = await request(app()).post('/api/projects/loom/threads').send({ kind: 'workshop', agent: 'gpt' });
    expect(anyAgent.status).toBe(201);
    expect(anyAgent.body.thread.agent).toBe('gpt');

    const nobody = await request(app()).post('/api/projects/loom/threads').send({ agent: 'llama' });
    expect(nobody.status).toBe(400);
    expect(nobody.body.error).toMatch(/don't know that agent/i);
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

    // And back out to a talker, which costs nothing and says so.
    const back = await request(app()).patch(`/api/threads/${thread.id}`).send({ agent: 'gpt' });
    expect(back.status).toBe(200);
    expect(back.body.thread.agent).toBe('gpt');
    expect(back.body.line).toMatch(/carries over as it is/i);
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
    const off = appWithOrg(orgId, createThreadsRouter(db, { lookup: stubRepoLookup, env: () => null }));
    const res = await request(off).post(`/api/threads/${thread.id}/message`).send({ text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't switched on/i);
    expect((await request(off).get('/api/inbox')).body.engine_on).toBe(false);
  });
});

/**
 * THE MOVE, REACHABLE ON PURPOSE — the standing options endpoint serves the
 * same choices the needs-project refusal carries, without the wall.
 */
describe('GET /api/threads/:id/build/options', () => {
  it('offers the projects and whether a new one can be made', async () => {
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
      await createPack(t.db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const subject = await createSubject(t.db, 'org_1', 'Ideas');
      const idea = await createSubjectThread(t.db, 'org_1', subject.id, { title: 'order notes' });
      const app = appWithOrg('org_1', createThreadsRouter(t.db, { lookup: stubRepoLookup, createRepo: async () => ({ fullName: 'acme/x' }) }));

      const res = await request(app).get(`/api/threads/${idea.id}/build/options`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        has_project: false,
        projects: [{ id: 'loom', name: 'Loom' }],
        can_create: true,
      });
    } finally {
      await t.close();
    }
  });

  it('says when the conversation already has a project, and offers nothing', async () => {
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
      await createPack(t.db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const thread = await createThread(t.db, 'org_1', 'loom', { kind: 'general', title: 'x' });
      const app = appWithOrg('org_1', createThreadsRouter(t.db, { lookup: stubRepoLookup }));
      const res = await request(app).get(`/api/threads/${thread.id}/build/options`);
      expect(res.body).toEqual({ has_project: true, projects: [], can_create: false });
    } finally {
      await t.close();
    }
  });
});

/**
 * ATTACHMENTS AT THE DOOR EVERYONE USES. This route quietly dropped `images`
 * and `files` while only the old workshop route read them: the composer
 * offered the buttons, the server read neither key, and a screenshot attached
 * to an Inbox conversation never arrived. Held here so it cannot regress.
 */
describe('attachments on the Inbox message route', () => {
  const png = Buffer.from('fake png bytes').toString('base64');

  it('carries inline images into the build turn', async () => {
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
      await createPack(t.db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const thread = await ensureWorkshopThread(t.db, 'org_1', 'loom');
      await t.db.update(threads).set({ agent: 'claude-code' }).where(eq(threads.id, thread.id));

      let seen: Record<string, unknown> = {};
      const app = appWithOrg('org_1', createThreadsRouter(t.db, {
        lookup: stubRepoLookup,
        env: () => ({ daytonaApiKey: 'd' }),
        runTurn: (async (_db, _org, _p, _t2, _cfg, options) => {
          seen = { images: options?.images, files: options?.files };
          return { runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: '', stagedChangesReady: false };
        }) as ThreadsDeps['runTurn'],
      }));
      const res = await request(app)
        .post(`/api/threads/${thread.id}/message`)
        .send({ text: 'look at this screenshot', images: [{ mime: 'image/png', dataBase64: png }] });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.images).toEqual([{ mime: 'image/png', dataBase64: png }]);
    } finally {
      await t.close();
    }
  });

  it('refuses an attachment to a talker with the way through, before the send', async () => {
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
      await createPack(t.db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const thread = await createThread(t.db, 'org_1', 'loom', { kind: 'general', title: 'x', agent: 'claude' });
      const app = appWithOrg('org_1', createThreadsRouter(t.db, { lookup: stubRepoLookup }));
      const res = await request(app)
        .post(`/api/threads/${thread.id}/message`)
        .send({ text: 'see attached', images: [{ mime: 'image/png', dataBase64: png }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('@claudecode');
    } finally {
      await t.close();
    }
  });

  it('refuses over the caps with the number, never trimming', async () => {
    const t = await createTestDb();
    try {
      await t.db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
      await createPack(t.db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const thread = await ensureWorkshopThread(t.db, 'org_1', 'loom');
      const app = appWithOrg('org_1', createThreadsRouter(t.db, { lookup: stubRepoLookup }));
      const eleven = Array.from({ length: 11 }, () => ({ mime: 'image/png', dataBase64: png }));
      const res = await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'x', images: eleven });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('10');
    } finally {
      await t.close();
    }
  });
});

