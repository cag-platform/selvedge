import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, llmUsage, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { runChatTurn, chatProviderFor, streamedReply } from '../../src/server/chat/turn.js';
import { subscribeLiveChat, type LiveChatEvent } from '../../src/server/chat/live.js';
import { DownLlmClient, FakeLlmClient } from '../../src/server/llm/fake.js';

/**
 * A general thread: plain conversation, no sandbox, nothing to ship — and the
 * reason it lives here rather than in a chat app is that it joins the record.
 * So the tests are about the record: the message lands, the spend is metered
 * against the thread, and every way this can fail says so on the thread rather
 * than leaving the owner talking to nothing.
 */
describe('a general thread turn', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const replying = (reply: string) =>
    new FakeLlmClient((req) => ({ ok: true, json: { reply }, tokensIn: Math.ceil(req.userContent.length / 4), tokensOut: 120, model: req.model }));

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A made-to-measure curtain shop.' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
      }),
    );
  });
  afterEach(async () => close());

  const chatThread = (agent: 'claude' | 'gpt' = 'claude') =>
    createThread(db, orgId, 'loom', { kind: 'general', title: 'Should we do subscriptions?', agent });

  it('lands both halves of the exchange on the thread', async () => {
    const thread = await chatThread();
    const out = await runChatTurn(db, orgId, thread, 'is a subscription worth it for us?', { client: replying('Probably not yet.') });
    expect(out).toMatchObject({ ok: true, reply: 'Probably not yet.' });

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId)).orderBy(agentMessages.createdAt);
    expect(messages.map((m) => m.role)).toEqual(['owner', 'agent']);
    expect(messages.every((m) => m.threadId === thread.id)).toBe(true);
  });

  it('records the consultation and prompt identity on a parallel answer', async () => {
    const thread = await chatThread();
    await runChatTurn(db, orgId, thread, 'which treatment reads better?', {
      client: replying('Keep the border subtle.'),
      recordOwnerMessage: false,
      answeringAs: 'codex',
      asTake: true,
      consultation: { id: 'consultation-1', promptId: 'owner-message-1' },
    });

    const [answer] = await db.select().from(agentMessages).where(eq(agentMessages.threadId, thread.id));
    expect(answer?.meta).toEqual({
      answered_by: 'codex',
      consultation_id: 'consultation-1',
      in_reply_to: 'owner-message-1',
    });
  });

  it('keeps that identity when one consulted agent cannot answer', async () => {
    const thread = await chatThread();
    await runChatTurn(db, orgId, thread, 'which treatment reads better?', {
      client: null,
      recordOwnerMessage: false,
      answeringAs: 'codex',
      asTake: true,
      consultation: { id: 'consultation-1', promptId: 'owner-message-1' },
    });

    const [answer] = await db.select().from(agentMessages).where(eq(agentMessages.threadId, thread.id));
    expect(answer?.meta).toMatchObject({
      answered_by: 'codex',
      consultation_id: 'consultation-1',
      in_reply_to: 'owner-message-1',
    });
    expect(answer?.content).toMatch(/no key connected/i);
  });

  it('gives the model the project it is talking about, and the conversation so far', async () => {
    const thread = await chatThread();
    const client = replying('ok');
    await runChatTurn(db, orgId, thread, 'first', { client });
    await runChatTurn(db, orgId, thread, 'and second', { client });

    const second = client.requests.at(-1)!;
    expect(second.userContent).toContain('Loom');
    expect(second.userContent).toContain('made-to-measure curtain shop');
    expect(second.userContent).toContain('first'); // the earlier turn is carried
    expect(second.userContent).toContain('and second');
    // It must not claim to see the live app from in here.
    expect(second.system).toMatch(/can't see that from this\s+conversation/i);
  });

  it('meters the spend against the thread, in the ledger everything else uses', async () => {
    const thread = await chatThread();
    await runChatTurn(db, orgId, thread, 'hello', { client: replying('hi') });

    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, orgId));
    expect(row!.purpose).toBe('chat');
    expect(row!.threadId).toBe(thread.id);
    expect(row!.costUsd).toBeGreaterThan(0);
    expect(row!.provider).toBe('anthropic');
  });

  it('runs on the provider the thread chose', async () => {
    const thread = await chatThread('gpt');
    const client = replying('hi');
    await runChatTurn(db, orgId, thread, 'hello', { client });
    expect(client.requests[0]!.model).toMatch(/^gpt-/);
    const [row] = await db.select().from(llmUsage).where(eq(llmUsage.orgId, orgId));
    expect(row!.provider).toBe('openai');
  });

  it('honours the model version saved on the thread', async () => {
    const thread = await createThread(db, orgId, 'loom', {
      kind: 'general', title: 'Fast answer', agent: 'gpt', model: 'gpt-5.6-luna',
    });
    const client = replying('hi');
    await runChatTurn(db, orgId, thread, 'hello', { client });
    expect(client.requests[0]!.model).toBe('gpt-5.6-luna');
  });

  it('says plainly when the thread runs on a model nobody connected', async () => {
    const thread = await chatThread('gpt');
    const out = await runChatTurn(db, orgId, thread, 'hello', { client: null });
    expect(out).toMatchObject({ ok: false, reason: 'no_fuel' });

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    // The owner's message is still on the record — the conversation happened
    // even though the answer didn't.
    expect(messages.map((m) => m.role)).toEqual(['owner', 'agent']);
    expect(messages[1]!.content).toMatch(/no key connected/i);
    expect(await db.select().from(llmUsage).where(eq(llmUsage.orgId, orgId))).toHaveLength(0);
  });

  it('stops at the daily limit — and says the brief is unaffected, because it is', async () => {
    const thread = await chatThread();
    // A day of thinking, already spent (the thinking side has its own cap).
    await db.insert(llmUsage).values({
      id: ulid(),
      orgId,
      purpose: 'chat',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 99,
      threadId: thread.id,
    });
    const client = replying('should not be called');
    const out = await runChatTurn(db, orgId, thread, 'hello', { client });
    expect(out).toMatchObject({ ok: false, reason: 'over_budget' });
    expect(client.requests).toHaveLength(0);
    const messages = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'agent')));
    expect(messages[0]!.content).toMatch(/daily limit/i);
    expect(messages[0]!.content).toMatch(/brief are unaffected/i);
  });

  it('a model that fails says so on the thread instead of going quiet', async () => {
    const thread = await chatThread();
    const out = await runChatTurn(db, orgId, thread, 'hello', { client: new DownLlmClient() });
    expect(out).toMatchObject({ ok: false, reason: 'model_failed' });
    const messages = await db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'agent')));
    expect(messages[0]!.content).toMatch(/ask me again/i);
    // A failed call still cost tokens, so it is still recorded.
    expect(await db.select().from(llmUsage).where(eq(llmUsage.orgId, orgId))).toHaveLength(1);
  });

  it('an empty answer is a failure, not an empty reply', async () => {
    const thread = await chatThread();
    const out = await runChatTurn(db, orgId, thread, 'hello', {
      client: new FakeLlmClient((req) => ({ ok: true, json: { reply: '   ' }, tokensIn: 1, tokensOut: 1, model: req.model })),
    });
    expect(out).toMatchObject({ ok: false, reason: 'model_failed' });
  });

  it('knows which agents can chat at all', () => {
    expect(chatProviderFor('claude')).toBe('anthropic');
    expect(chatProviderFor('gpt')).toBe('openai');
    expect(chatProviderFor('claude-code')).toBeNull(); // a builder, not a chat model
  });

  it('publishes a readable partial reply, then persists the validated answer', async () => {
    const thread = await chatThread();
    const events: LiveChatEvent[] = [];
    const unsubscribe = subscribeLiveChat(orgId, thread.id, (event) => events.push(event));
    const client = new FakeLlmClient((req) => {
      req.onTextDelta?.('{"reply":"Hello');
      req.onTextDelta?.(' there\\nfriend"}');
      return { ok: true, json: { reply: 'Hello there\nfriend' }, tokensIn: 2, tokensOut: 3, model: req.model };
    });
    await runChatTurn(db, orgId, thread, 'hello', { client });
    unsubscribe();

    expect(events.map((event) => event.type)).toEqual(['reply_started', 'reply_delta', 'reply_delta', 'reply_finished']);
    expect(events.filter((event): event is Extract<LiveChatEvent, { type: 'reply_delta' }> => event.type === 'reply_delta').map((event) => event.text).join('')).toBe('Hello there\nfriend');
  });
});

describe('streamedReply', () => {
  it('reveals only the reply string and decodes complete escapes', () => {
    expect(streamedReply('{"reply":"hello\\nworld')).toBe('hello\nworld');
    expect(streamedReply('{"reply":"quote: \\"yes\\""}')).toBe('quote: "yes"');
    expect(streamedReply('{"reply":"wait\\u2')).toBe('wait');
  });
});
