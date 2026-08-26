import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { createThread, getThread } from '../../src/server/threads/store.js';
import { setBuild } from '../../src/server/build/store.js';
import { MAX_CONSULTED } from '../../src/shared/mentions.js';
import { appWithOrg } from './helpers.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';
import { ulid } from 'ulid';
import { groupPairedConsultations } from '../../src/client/lib/consultation.js';
import type { ThreadMessage } from '../../src/client/lib/inbox.js';
import type { TaskContextCapsule } from '../../src/shared/types/contextCapsule.js';

/**
 * @-MENTIONS, THROUGH THE ROUTE.
 *
 * `test/shared/mentions.test.ts` proves the parse. This proves what the parse
 * causes: who ends up answering, whether the conversation changes hands, and —
 * the part that would be expensive to get wrong — that asking two agents for a
 * take does not turn into two agents editing the same sandbox.
 */
describe('choosing who answers by naming them', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  /** Every chat turn the route started, in order. */
  let takes: Array<{
    agent: string | undefined;
    text: string;
    asTake: boolean;
    recorded: boolean;
    consultation: { id: string; promptId: string } | undefined;
    capsule?: TaskContextCapsule;
  }>;
  /** Every build turn the route started. */
  let builds: Array<{ agent: string; text: string; mode?: string; recorded: boolean; consultation?: { id: string; promptId: string }; capsule?: TaskContextCapsule }>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    takes = [];
    builds = [];
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }),
    );
  });
  afterEach(async () => close());

  const app = () =>
    appWithOrg(
      orgId,
      createThreadsRouter(db, { lookup: stubRepoLookup,
        env: () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' }),
        chatTurn: async (_db, _orgId, _thread, text, deps) => {
          takes.push({
            agent: deps?.answeringAs,
            text,
            asTake: deps?.asTake === true,
            recorded: deps?.recordOwnerMessage !== false,
            consultation: deps?.consultation,
            capsule: deps?.contextCapsule,
          });
          return { ok: true, reply: 'noted.', model: 'test', costed: true };
        },
        runTurn: (async (_db, _org, _projectId, text, cfg, options) => {
          builds.push({ agent: cfg.agent, text, mode: options?.mode, recorded: options?.recordOwnerMessage !== false, consultation: options?.consultation,
            ...(options?.contextCapsule ? { capsule: options.contextCapsule } : {}) });
          return { runId: 'r', agent: cfg.agent, status: 'succeeded', costCents: 1, reply: 'ok', stagedChangesReady: false };
        }) as ThreadsDeps['runTurn'],
      }),
    );

  const talking = () => createThread(db, orgId, 'loom', { kind: 'general', title: 'Gift notes' });
  const send = (id: string, text: string) => request(app()).post(`/api/threads/${id}/message`).send({ text });
  const messages = (threadId: string) =>
    db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, threadId)))
      .orderBy(asc(agentMessages.createdAt));

  /**
   * THE MOVE THE WHOLE REDESIGN IS FOR: you work something out with a talker,
   * then say "ok build it" to a builder in the same breath, in the same
   * conversation.
   */
  it('hands the conversation to a builder when you name one, and builds', async () => {
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
    const thread = await talking();
    expect(thread.agent).toBe('claude');

    await send(thread.id, '@claudecode ok build it').expect(202);

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ agent: 'claude-code', text: '@claudecode ok build it', recorded: true });
    expect(builds[0]!.capsule).toBeDefined();
    expect(takes).toEqual([]);
    expect((await getThread(db, orgId, thread.id))!.agent).toBe('claude-code');
  });

  it('hands it back to a talker the same way', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout' });
    expect(thread.agent).toBe('claude-code');

    await send(thread.id, '@gpt is that the right call?').expect(202);

    expect(builds).toEqual([]);
    expect(takes).toHaveLength(1);
    expect((await getThread(db, orgId, thread.id))!.agent).toBe('gpt');
  });

  it('carries on with whoever answered last when nobody is named', async () => {
    const thread = await talking();
    await send(thread.id, 'and what about per-item?').expect(202);

    expect(takes).toHaveLength(1);
    expect(builds).toEqual([]);
    expect((await getThread(db, orgId, thread.id))!.agent).toBe('claude');
  });

  it('runs one conversational answer beside one real builder', async () => {
    const thread = await talking();
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });

    const res = await send(thread.id, '@claude @claudecode explain it and build it').expect(202);
    expect(res.body.consulted).toEqual(['claude', 'claude-code']);

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      agent: 'claude-code', text: '@claude @claudecode explain it and build it', recorded: false,
      consultation: { id: res.body.consultation_id, promptId: takes[0]!.consultation!.promptId },
    });
    expect(takes.map((t) => t.agent)).toEqual(['claude']);
    expect(takes.every((t) => t.asTake)).toBe(true);
    expect(takes[0]!.consultation?.id).toBe(res.body.consultation_id);
    expect(takes[0]!.capsule?.capsule_id).toBe(builds[0]!.capsule?.capsule_id);
    expect(takes[0]!.capsule?.content_hash).toBe(builds[0]!.capsule?.content_hash);

    expect((await getThread(db, orgId, thread.id))!.agent).toBe('claude');
  });

  it('uses a builder read-only when the request is to inspect and plan', async () => {
    const thread = await talking();
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
    await send(thread.id, '@claude @gpt @codex look at the code, plan the migration, and walk me through it').expect(202);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ agent: 'codex', mode: 'plan' });
    const line = (await messages(thread.id)).find((row) => row.role === 'switch');
    expect(line?.content).toMatch(/planning without changing files/i);
  });

  it('freezes one capsule for every conversational lane and records its receipt on the prompt', async () => {
    const thread = await talking();
    const res = await send(thread.id, '@gpt @gemini review the current work').expect(202);
    expect(takes).toHaveLength(2);
    expect(takes[0]!.capsule).toBeDefined();
    expect(takes[1]!.capsule).toEqual(takes[0]!.capsule);

    const rows = await messages(thread.id);
    const owner = rows.find((row) => row.role === 'owner')!;
    expect(owner.meta).toMatchObject({
      consultation_id: res.body.consultation_id,
      context_capsule_id: takes[0]!.capsule!.capsule_id,
      context_capsule_hash: takes[0]!.capsule!.content_hash,
    });
  });

  it('refreshes the builder capsule and carries consulted answers as discussion, not durable truth', async () => {
    const thread = await talking();
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
    const consultation = await send(thread.id, '@gpt @gemini review idempotency').expect(202);
    const firstCapsule = takes[0]!.capsule!;
    const prompt = (await messages(thread.id)).find((row) => row.role === 'owner')!;
    await db.insert(agentMessages).values([
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'Use an idempotency key.',
        meta: { answered_by: 'gpt', consultation_id: consultation.body.consultation_id, in_reply_to: prompt.id } },
      { id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'Use a short cache window.',
        meta: { answered_by: 'gemini', consultation_id: consultation.body.consultation_id, in_reply_to: prompt.id } },
    ]);

    await send(thread.id, '@claudecode use GPT’s idempotency suggestion and continue').expect(202);
    const builderCapsule = builds.at(-1)!.capsule!;
    expect(builderCapsule.capsule_id).not.toBe(firstCapsule.capsule_id);
    expect(builderCapsule.observed_now.referenced_prior_answers.map((answer) => answer.value).join('\n')).toContain('gpt opinion: Use an idempotency key.');
    expect(builderCapsule.known_already.accepted_decisions).toEqual([]);
    expect(builderCapsule.known_already.graduated_project_knowledge).toEqual([]);
  });

  it('retries only the failed conversational lane with the exact frozen capsule', async () => {
    const thread = await talking();
    const consultation = await send(thread.id, '@gpt @gemini review it').expect(202);
    const frozen = takes[0]!.capsule!;
    const prompt = (await messages(thread.id)).find((row) => row.role === 'owner')!;
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'GPT was unavailable.',
      meta: { answered_by: 'gpt', consultation_id: consultation.body.consultation_id, in_reply_to: prompt.id,
        consultation_lane: { status: 'failed', failure_code: 'model_unavailable', retryable: false } } });

    const retried = await request(app()).post(`/api/threads/${thread.id}/consultations/${consultation.body.consultation_id}/retry`).send({ agent: 'gpt' }).expect(202);
    expect(retried.body.context_capsule_id).toBe(frozen.capsule_id);
    expect(takes).toHaveLength(3);
    expect(takes[2]!.agent).toBe('gpt');
    expect(takes[2]!.capsule).toEqual(frozen);
  });

  it('refuses two builders until the owner chooses an order', async () => {
    const thread = await talking();
    const res = await send(thread.id, '@codex @claudecode build both versions').expect(409);
    expect(res.body).toMatchObject({ code: 'choose_builder_order', builders: ['codex', 'claude-code'] });
    expect(builds).toEqual([]);
    expect(takes).toEqual([]);
  });

  /** The question is asked once, however many people are asked it. */
  it('writes the question once, and says on the record who was asked', async () => {
    const thread = await talking();
    await send(thread.id, '@claude @gpt worth doing?').expect(202);

    const rows = await messages(thread.id);
    const owner = rows.filter((r) => r.role === 'owner');
    expect(owner).toHaveLength(1);
    expect(owner[0]!.content).toBe('@claude @gpt worth doing?');
    expect(takes.every((t) => !t.recorded)).toBe(true);

    const line = rows.find((r) => r.role === 'switch');
    expect(line?.content).toContain('Claude and GPT');
    expect(line?.content).toMatch(/nothing was built/i);
    expect((line?.meta as { consulted?: string[] })?.consulted).toEqual(['claude', 'gpt']);
    const ownerMeta = owner[0]!.meta as { consultation_id?: string };
    const lineMeta = line?.meta as {
      consultation_id?: string;
      consultation?: { id: string; prompt_id: string; agents: string[] };
    };
    expect(lineMeta.consultation).toEqual({
      id: ownerMeta.consultation_id,
      prompt_id: owner[0]!.id,
      agents: ['claude', 'gpt'],
    });
    expect(takes.every((take) => take.consultation?.id === ownerMeta.consultation_id)).toBe(true);
    expect(takes.every((take) => take.consultation?.promptId === owner[0]!.id)).toBe(true);
  });

  it('keeps overlapping consultations with the same agents unambiguously separate on the wire', async () => {
    const thread = await talking();
    await send(thread.id, '@claude @gpt compare the divider').expect(202);
    await send(thread.id, '@claude @gpt compare the type scale').expect(202);

    const first = takes[0]!.consultation!;
    const second = takes[2]!.consultation!;
    expect(takes[1]!.consultation).toEqual(first);
    expect(takes[3]!.consultation).toEqual(second);
    expect(second.id).not.toBe(first.id);
    expect(second.promptId).not.toBe(first.promptId);

    const afterPrompts = Date.now() + 1_000;
    await db.insert(agentMessages).values([
      {
        id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'first / Claude',
        meta: { answered_by: 'claude', consultation_id: first.id, in_reply_to: first.promptId },
        createdAt: new Date(afterPrompts),
      },
      {
        id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'second / Claude',
        meta: { answered_by: 'claude', consultation_id: second.id, in_reply_to: second.promptId },
        createdAt: new Date(afterPrompts + 1),
      },
      {
        id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'first / GPT',
        meta: { answered_by: 'gpt', consultation_id: first.id, in_reply_to: first.promptId },
        createdAt: new Date(afterPrompts + 2),
      },
      {
        id: ulid(), orgId, projectId: 'loom', threadId: thread.id, role: 'agent', content: 'second / GPT',
        meta: { answered_by: 'gpt', consultation_id: second.id, in_reply_to: second.promptId },
        createdAt: new Date(afterPrompts + 3),
      },
    ]);

    const response = await request(app()).get(`/api/threads/${thread.id}`).expect(200);
    const wire = response.body.messages as ThreadMessage[];
    const replies = wire.filter((message) => message.role === 'agent');
    expect(replies.map((reply) => [reply.consultation_id, reply.in_reply_to])).toEqual([
      [first.id, first.promptId],
      [second.id, second.promptId],
      [first.id, first.promptId],
      [second.id, second.promptId],
    ]);
    // Same authors and interleaved arrival are not evidence of a pair. The
    // exact correlations prevent either consultation borrowing the other's
    // late answer.
    expect(groupPairedConsultations(wire).every((item) => item.kind === 'message')).toBe(true);
  });

  /**
   * Every name on the line is another turn on the owner's own key. A message
   * that quietly fanned out to six of them would be the exact kind of surprise
   * this product exists not to produce.
   */
  it('caps how many are asked at once', async () => {
    const thread = await talking();
    await send(thread.id, '@claude @gpt @gemini @kimi everyone').expect(202);

    expect(takes).toHaveLength(MAX_CONSULTED);
  });

  /** A name nobody recognises is prose, not a request — the message still sends. */
  it('sends a message that merely contains an @', async () => {
    const thread = await talking();
    await send(thread.id, 'forward it to greg@smithbespoke.com').expect(202);

    expect(takes).toHaveLength(1);
    expect(takes[0]!.agent).toBeUndefined();
  });
});
