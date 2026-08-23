import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, connectorCredentials, orgs, subscriptions } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread, getThread } from '../../src/server/threads/store.js';
import { createDecisionsRouter } from '../../src/server/web/routes/decisions.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { briefForThinkingThread } from '../../src/server/decisions/store.js';
import { AnthropicLlmClient } from '../../src/server/llm/anthropic.js';
import { appWithOrg } from './helpers.js';
import { onPlan } from '../helpers/plan.js';

/**
 * PAIRED THREADS, END TO END: think, decide, build — and the guard that stands
 * between the second and the third.
 *
 * The feature's known failure is a decision that has fallen behind the
 * conversation being built from as though it hadn't. Everything below is about
 * whether that can happen.
 */
describe('web/routes/decisions — thinking, deciding, building', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    // Decision briefs are a Pro feature, so the org that exercises them is on
    // Pro. Said out loud rather than assumed: the gate itself is tested below.
    await onPlan(db, orgId);
    await onPlan(db, 'org_2');
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    // The platform key stands in for the org's fuel, so extraction can run.
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  const decisions = () => appWithOrg(orgId, createDecisionsRouter(db));
  const threadsApp = (deps: ThreadsDeps = {}) => appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, ...deps }));

  async function aThinkingThread(messages: string[] = ['should the checkout be one page?', 'One page usually converts better.']) {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Checkout shape' });
    let at = Date.now() - messages.length * 60_000;
    for (const [i, content] of messages.entries()) {
      await db.insert(agentMessages).values({
        id: ulid(),
        orgId,
        projectId: 'loom',
        threadId: thread.id,
        role: i % 2 === 0 ? 'owner' : 'agent',
        content,
        createdAt: new Date((at += 60_000)),
      });
    }
    return thread;
  }

  /** The extraction call goes through the real fuel seam; this stands in for the model. */
  async function withFakeModel<T>(json: unknown, run: () => PromiseLike<T>): Promise<T> {
    const proto = AnthropicLlmClient.prototype as unknown as { complete: unknown };
    const original = proto.complete;
    proto.complete = async (req: { model: string }) => ({ ok: true, json, tokensIn: 10, tokensOut: 10, model: req.model });
    try {
      return await run();
    } finally {
      proto.complete = original;
    }
  }

  const DRAFT = {
    title: 'One-page checkout',
    decision: 'Make the checkout one page, with the address step kept separate.',
    why: 'Shorter forms convert better.',
    constraints: ['do not touch payment'],
    open_questions: ['what happens to saved baskets?'],
  };

  it('extracts a decision from the thinking, dated to what it saw', async () => {
    const thread = await aThinkingThread();
    const res = await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thread.id}/decision`).send({}));

    expect(res.status).toBe(201);
    expect(res.body.brief).toMatchObject({ title: 'One-page checkout', evidenceMessages: 2 });
    expect(res.body.brief.openQuestions).toEqual(['what happens to saved baskets?']);
    // Never handed out bare: a brief always arrives with how current it is.
    expect(res.body.freshness).toMatchObject({ state: 'current', behind: 0 });
  });

  it('goes stale the moment the thinking moves on, and says by how much', async () => {
    const thread = await aThinkingThread();
    await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thread.id}/decision`).send({}));

    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      role: 'owner',
      content: "actually, keep it three pages — people panic at long forms",
    });

    const res = await request(decisions()).get(`/api/threads/${thread.id}/decision`);
    expect(res.body.freshness).toMatchObject({ state: 'stale', behind: 1 });
    expect(res.body.freshness.note).toMatch(/may no longer be what you decided/);
  });

  it('a person\'s edit replaces the extraction, and does not re-date it', async () => {
    const thread = await aThinkingThread();
    const made = await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thread.id}/decision`).send({}));

    const edited = await request(decisions())
      .patch(`/api/decisions/${made.body.brief.id}`)
      .send({ decision: 'One page, and the address step goes with it.' });
    expect(edited.status).toBe(200);
    expect(edited.body.brief.decision).toBe('One page, and the address step goes with it.');
    expect(edited.body.brief.editedByHuman).toBe(true);
    // Editing is not new evidence: it still saw only what it saw.
    expect(edited.body.brief.evidenceMessages).toBe(made.body.brief.evidenceMessages);
    expect(edited.body.freshness.state).toBe('current');
  });

  it('starts the building thread, paired, with the decision on the record', async () => {
    const thread = await aThinkingThread();
    const made = await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thread.id}/decision`).send({}));

    const built = await request(decisions()).post(`/api/decisions/${made.body.brief.id}/build`).send({});
    expect(built.status).toBe(201);
    const building = await getThread(db, orgId, built.body.thread.id);
    expect(building!.kind).toBe('workshop');
    expect(building!.title).toBe('One-page checkout');

    // Both halves now find the same decision.
    const fromBuilding = await request(decisions()).get(`/api/threads/${building!.id}/decision`);
    expect(fromBuilding.body.brief.id).toBe(made.body.brief.id);

    const [line] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.threadId, building!.id), eq(agentMessages.role, 'switch')));
    expect(line!.content).toContain('built from the decision in "One-page checkout"');

    // Asking twice does not open a second thread.
    const again = await request(decisions()).post(`/api/decisions/${made.body.brief.id}/build`).send({});
    expect(again.body.already).toBe(true);
    expect(again.body.thread.id).toBe(building!.id);
  });

  it('REFUSES to build from a decision the thinking has moved past — until you say you know', async () => {
    const thinking = await aThinkingThread();
    const made = await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thinking.id}/decision`).send({}));
    const built = await request(decisions()).post(`/api/decisions/${made.body.brief.id}/build`).send({});
    const buildingId = built.body.thread.id;

    // The owner changes their mind after the decision was written.
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thinking.id,
      role: 'owner',
      content: 'actually keep it three pages',
    });

    let started = 0;
    const app = threadsApp({
      runTurn: (async () => {
        started += 1;
        return { runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: '', stagedChangesReady: false };
      }) as ThreadsDeps['runTurn'],
    });

    const blocked = await request(app).post(`/api/threads/${buildingId}/message`).send({ text: 'build it' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/may no longer be what you decided/);
    expect(blocked.body.stale_decision).toMatchObject({ behind: 1, thinking_thread_id: thinking.id });
    expect(started).toBe(0); // nothing ran

    // Said deliberately, it proceeds — and the thread records that it did.
    const proceeded = await request(app).post(`/api/threads/${buildingId}/message`).send({ text: 'build it', acknowledge_stale: true });
    expect(proceeded.status).toBe(202);
    expect(started).toBe(1);

    const lines = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.threadId, buildingId), eq(agentMessages.role, 'switch')));
    expect(lines.map((l) => l.content).join('\n')).toMatch(/built from the decision as it stood — 1 later message/);
  });

  it('hands the builder the decision, and the warning when it is behind', async () => {
    const thinking = await aThinkingThread();
    const made = await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thinking.id}/decision`).send({}));
    const built = await request(decisions()).post(`/api/decisions/${made.body.brief.id}/build`).send({});

    let handoff = '';
    const app = threadsApp({
      runTurn: (async (_db, _org, _p, _t, _cfg, options) => {
        handoff = String(options?.handoff ?? '');
        return { runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: '', stagedChangesReady: false };
      }) as ThreadsDeps['runTurn'],
    });
    await request(app).post(`/api/threads/${built.body.thread.id}/message`).send({ text: 'go' });

    expect(handoff).toContain('WHAT WAS DECIDED');
    expect(handoff).toContain('Make the checkout one page');
    expect(handoff).toContain('do not touch payment');
    // The open question travels with it, and the builder is told not to answer it.
    expect(handoff).toContain('what happens to saved baskets?');
    expect(handoff).toMatch(/do NOT settle these yourself/);
    expect(handoff).not.toMatch(/draft, not a settled decision/); // current, so no warning
  });

  it('refuses to decide in a building thread, or from an empty conversation', async () => {
    const workshop = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Build' });
    expect((await request(decisions()).post(`/api/threads/${workshop.id}/decision`).send({})).status).toBe(400);

    const empty = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Nothing said yet' });
    const res = await request(decisions()).post(`/api/threads/${empty.id}/decision`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing in this conversation yet/i);
  });

  it('is org-scoped', async () => {
    const thread = await aThinkingThread();
    await withFakeModel(DRAFT, () => request(decisions()).post(`/api/threads/${thread.id}/decision`).send({}));
    const brief = (await briefForThinkingThread(db, orgId, thread.id))!;

    const theirs = appWithOrg('org_2', createDecisionsRouter(db));
    expect((await request(theirs).get(`/api/threads/${thread.id}/decision`)).body.brief).toBeNull();
    expect((await request(theirs).patch(`/api/decisions/${brief.id}`).send({ decision: 'mine now' })).status).toBe(404);
    expect((await request(theirs).post(`/api/decisions/${brief.id}/build`).send({})).status).toBe(404);
  });

  /**
   * THE PAYWALL, AND WHERE IT DELIBERATELY STOPS.
   *
   * Extracting a decision is the Pro feature. Everything that operates on a
   * brief already made is NOT gated, and the reason is not generosity: the
   * stale-decision check is a safety guard, and a lapsed subscription must
   * never be more dangerous than no subscription. A brief that keeps feeding
   * the builder while being hidden from the owner would be the screen and the
   * work disagreeing about what is happening.
   */
  describe('what a Free account can and cannot do with a decision', () => {
    const free = 'org_free';

    beforeEach(async () => {
      await db.insert(orgs).values({ orgId: free });
      await createPack(
        db,
        free,
        makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }),
      );
    });

    it('refuses to extract one, with the price and a code the client can act on', async () => {
      const thread = await createThread(db, free, 'loom', { kind: 'general', title: 'Checkout shape' });
      await db.insert(agentMessages).values({
        id: ulid(),
        orgId: free,
        projectId: 'loom',
        threadId: thread.id,
        role: 'owner',
        content: 'should the checkout be one page?',
      });

      const res = await request(appWithOrg(free, createDecisionsRouter(db))).post(`/api/threads/${thread.id}/decision`).send({});
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('limit_decision_briefs');
      expect(res.body.error).toMatch(/\$12\/month/);
    });

    /** Refused before the model is ever called — a paywall that spends money is not a paywall. */
    it('refuses before anything spends', async () => {
      const thread = await createThread(db, free, 'loom', { kind: 'general', title: 'Checkout shape' });
      await db.insert(agentMessages).values({ id: ulid(), orgId: free, projectId: 'loom', threadId: thread.id, role: 'owner', content: 'one page?' });

      let called = false;
      const proto = AnthropicLlmClient.prototype as unknown as { complete: unknown };
      const original = proto.complete;
      proto.complete = async () => {
        called = true;
        return { ok: true, json: DRAFT, tokensIn: 1, tokensOut: 1, model: 'x' };
      };
      try {
        await request(appWithOrg(free, createDecisionsRouter(db))).post(`/api/threads/${thread.id}/decision`).send({});
      } finally {
        proto.complete = original;
      }
      expect(called).toBe(false);
    });

    it('still serves and still guards a brief made while the account was paying', async () => {
      const thread = await createThread(db, free, 'loom', { kind: 'general', title: 'Checkout shape' });
      await db.insert(agentMessages).values({ id: ulid(), orgId: free, projectId: 'loom', threadId: thread.id, role: 'owner', content: 'one page?' });
      // Made on Pro, then the subscription lapsed.
      await onPlan(db, free);
      await withFakeModel(DRAFT, () => request(appWithOrg(free, createDecisionsRouter(db))).post(`/api/threads/${thread.id}/decision`).send({}));
      await db.delete(subscriptions).where(eq(subscriptions.orgId, free));

      const res = await request(appWithOrg(free, createDecisionsRouter(db))).get(`/api/threads/${thread.id}/decision`);
      expect(res.status).toBe(200);
      expect(res.body.brief).not.toBeNull();
      expect(res.body.freshness).toBeTruthy();
    });
  });
});
