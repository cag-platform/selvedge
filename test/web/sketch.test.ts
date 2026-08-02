import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createSketchRouter } from '../../src/server/web/routes/sketch.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import type { LlmRequest, LlmResult } from '../../src/server/llm/types.js';
import { checkDailyBudget, checkSketchBudget } from '../../src/server/llm/budget.js';
import { appWithOrg } from './helpers.js';

const speaks = (json: Record<string, unknown>) =>
  new FakeLlmClient((req: LlmRequest): LlmResult => ({ ok: true, json, tokensIn: 10, tokensOut: 20, model: req.model }));

const thinking = { reply: 'What happens to orders already placed?', questions: ['What about existing orders?'], ready: false, brief: null };
const settled = { reply: "Here's what I'd build.", questions: [], ready: true, brief: 'Add a Cancel button for one hour after an order is placed.' };

describe('web/routes/sketch — the room for thinking, before the workshop', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'where retailers order' } }));
  });
  afterEach(async () => close());

  const app = (llm = speaks(thinking), handOff?: (o: string, p: string, t: string) => Promise<void>) =>
    appWithOrg(orgId, createSketchRouter(db, { resolveDeps: async () => ({ llm, db }), ...(handOff ? { handOff } : {}) }));

  it('starts an idea, answers in the same request, and titles it from what was said', async () => {
    const res = await request(app()).post('/api/sketches').send({ text: 'let retailers cancel an order', project_id: 'loom' });

    expect(res.status).toBe(201);
    // Synchronous: the reply is already there, no polling needed.
    expect(res.body.thread).toHaveLength(2);
    expect(res.body.thread[0]).toMatchObject({ role: 'owner', content: 'let retailers cancel an order' });
    expect(res.body.thread[1]).toMatchObject({ role: 'sketch', content: thinking.reply });
    expect(res.body.sketch.title).toBe('let retailers cancel an order');
    expect(res.body.sketch.ready).toBe(false);
    expect(res.body.questions).toEqual(['What about existing orders?']);
  });

  it('keeps the conversation going, and only offers a brief once the idea is settled', async () => {
    const created = await request(app()).post('/api/sketches').send({ text: 'cancelling orders', project_id: 'loom' });
    const id = created.body.sketch.id;
    expect(created.body.sketch.brief).toBeNull();

    const done = await request(app(speaks(settled))).post(`/api/sketches/${id}/messages`).send({ text: 'within an hour' });
    expect(done.status).toBe(200);
    expect(done.body.sketch.ready).toBe(true);
    expect(done.body.sketch.brief).toBe(settled.brief);
    expect(done.body.thread).toHaveLength(4);
  });

  it('a follow-up that reopens the question clears the stale brief — the button must not stay lit', async () => {
    const created = await request(app(speaks(settled))).post('/api/sketches').send({ text: 'cancelling', project_id: 'loom' });
    const id = created.body.sketch.id;
    expect(created.body.sketch.ready).toBe(true);

    const reopened = await request(app(speaks(thinking))).post(`/api/sketches/${id}/messages`).send({ text: 'actually, what about refunds?' });
    expect(reopened.body.sketch.ready).toBe(false);
    expect(reopened.body.sketch.brief).toBeNull();
  });

  it('hands the brief to the workshop and remembers that it did', async () => {
    const handed: Array<{ projectId: string; text: string }> = [];
    const withHandoff = app(speaks(settled), async (_o, projectId, text) => void handed.push({ projectId, text }));

    const created = await request(withHandoff).post('/api/sketches').send({ text: 'cancelling', project_id: 'loom' });
    const id = created.body.sketch.id;

    const res = await request(withHandoff).post(`/api/sketches/${id}/handoff`).send({});
    expect(res.status).toBe(200);
    expect(handed).toEqual([{ projectId: 'loom', text: settled.brief }]);

    const after = await request(withHandoff).get(`/api/sketches/${id}`);
    expect(after.body.sketch.handed_off_at).not.toBeNull();
  });

  it('refuses to hand over an idea that is not settled, and says why', async () => {
    const created = await request(app()).post('/api/sketches').send({ text: 'something vague', project_id: 'loom' });
    const res = await request(app()).post(`/api/sketches/${created.body.sketch.id}/handoff`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/isn't settled enough/i);
  });

  it('a failed handoff says so instead of pretending the workshop got it', async () => {
    const failing = app(speaks(settled), async () => {
      throw new Error("the workshop isn't switched on yet");
    });
    const created = await request(failing).post('/api/sketches').send({ text: 'cancelling', project_id: 'loom' });
    const res = await request(failing).post(`/api/sketches/${created.body.sketch.id}/handoff`).send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/switched on/i);
    expect(res.body.error).toMatch(/nothing was started/i);
    // And it is NOT marked as handed off, because it wasn't.
    const after = await request(failing).get(`/api/sketches/${created.body.sketch.id}`);
    expect(after.body.sketch.handed_off_at).toBeNull();
  });

  it('asks which project when an idea has no home yet', async () => {
    const created = await request(app(speaks(settled))).post('/api/sketches').send({ text: 'an idea with no project' });
    const res = await request(app(speaks(settled))).post(`/api/sketches/${created.body.sketch.id}/handoff`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/which project/i);
  });

  it('says plainly when no model is connected, rather than erroring', async () => {
    const noFuel = appWithOrg(orgId, createSketchRouter(db, { resolveDeps: async () => undefined }));
    const res = await request(noFuel).post('/api/sketches').send({ text: 'an idea' });
    expect(res.status).toBe(201);
    expect(res.body.available).toBe(false);
    // The honest line lands on the thread, so the room is never just silent.
    expect(res.body.thread[1].content).toMatch(/no AI model/i);
  });

  it('stops at the day\'s thinking budget with a plain sentence, and says the watching is unaffected', async () => {
    await db.insert(llmUsage).values({ id: ulid(), orgId, purpose: 'sketch', model: 'claude-sonnet-5', tokensIn: 1, tokensOut: 1, costUsd: 99 });
    const res = await request(app()).post('/api/sketches').send({ text: 'one more idea', project_id: 'loom' });
    expect(res.status).toBe(201);
    expect(res.body.thread[1].content).toMatch(/thinking budget/i);
    expect(res.body.thread[1].content).toMatch(/brief are unaffected/i);
  });

  it('sketching can never starve the daily brief — the two budgets are separate', async () => {
    // Spend far past the watching's cap, but all of it on sketching.
    await db.insert(llmUsage).values({ id: ulid(), orgId, purpose: 'sketch', model: 'claude-sonnet-5', tokensIn: 1, tokensOut: 1, costUsd: 50 });

    const watching = await checkDailyBudget(db, orgId);
    expect(watching.over).toBe(false); // the brief still has its full allowance
    expect(watching.spentUsd).toBe(0);

    const sketching = await checkSketchBudget(db, orgId);
    expect(sketching.over).toBe(true); // and sketching has spent its own

    // And the reverse: brief spend does not eat the thinking budget.
    await db.insert(llmUsage).values({ id: ulid(), orgId, purpose: 'compose', model: 'claude-fable-5', tokensIn: 1, tokensOut: 1, costUsd: 50 });
    expect((await checkSketchBudget(db, orgId)).spentUsd).toBe(50);
    expect((await checkDailyBudget(db, orgId)).spentUsd).toBe(50);
  });

  it('400s on an empty message, and 404s on an unknown project or sketch', async () => {
    expect((await request(app()).post('/api/sketches').send({ text: '  ' })).status).toBe(400);
    expect((await request(app()).post('/api/sketches').send({ text: 'x', project_id: 'nope' })).status).toBe(404);
    expect((await request(app()).get('/api/sketches/nope')).status).toBe(404);
    expect((await request(app()).post('/api/sketches/nope/messages').send({ text: 'x' })).status).toBe(404);
  });

  it('is org-scoped: another org never sees the thread, the list, or the ability to delete it', async () => {
    const created = await request(app()).post('/api/sketches').send({ text: 'my private idea', project_id: 'loom' });
    const id = created.body.sketch.id;

    const other = appWithOrg('org_2', createSketchRouter(db, { resolveDeps: async () => ({ llm: speaks(thinking), db }) }));
    expect((await request(other).get(`/api/sketches/${id}`)).status).toBe(404);
    expect((await request(other).delete(`/api/sketches/${id}`)).status).toBe(404);
    expect((await request(other).get('/api/sketches')).body.sketches).toHaveLength(0);

    // Still there for its owner.
    expect((await request(app()).get('/api/sketches')).body.sketches).toHaveLength(1);
  });

  it('lists ideas freshest first, and deletes one for good', async () => {
    const a = await request(app()).post('/api/sketches').send({ text: 'first idea', project_id: 'loom' });
    await request(app()).post('/api/sketches').send({ text: 'second idea', project_id: 'loom' });

    const list = await request(app()).get('/api/sketches');
    expect(list.body.sketches.map((s: { title: string }) => s.title)).toEqual(['second idea', 'first idea']);

    expect((await request(app()).delete(`/api/sketches/${a.body.sketch.id}`)).status).toBe(200);
    expect((await request(app()).get('/api/sketches')).body.sketches).toHaveLength(1);
  });
});
