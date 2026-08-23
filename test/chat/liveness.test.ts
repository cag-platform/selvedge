import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { createThread } from '../../src/server/threads/store.js';
import { switchThreadAgent } from '../../src/server/threads/switch.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { AnthropicLlmClient } from '../../src/server/llm/anthropic.js';
import { OpenAiLlmClient } from '../../src/server/llm/openai.js';
import type { LlmClient } from '../../src/server/llm/types.js';
import type { Thread } from '../../src/server/threads/store.js';
import { AGENTS } from '../../src/shared/agents.js';
import { appWithOrg } from '../web/helpers.js';

/**
 * IS THE CHAT HALF ACTUALLY LIVE?
 *
 * `test/chat/turn.test.ts` proves the turn itself against a fake client. What
 * it cannot prove is the wiring either side of it: that a message posted to a
 * general thread reaches that turn holding a REAL client, built from the key
 * the owner connected for the agent THIS thread runs on.
 *
 * That question decided the whole redesign: the product's thesis is one place
 * to work across every agent, and three of the four were marked `live: false`.
 * These tests established that the flag was a label rather than a capability
 * limit — the route is exercised over HTTP and the client the chat turn
 * receives is inspected rather than stubbed away — and the wall came down on
 * the strength of them.
 *
 * The model is never actually called. Proving the network works is the
 * provider SDK's job; proving Selvedge hands it the right client, built from
 * the right key, for the right agent, is this file's.
 */
describe('the chat half, end to end', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  /** What the route handed the chat turn on the last request. */
  let handed: { thread: Thread; text: string; client: LlmClient | null } | null;

  beforeEach(async () => {
    // The vault refuses to encrypt without its own root, by design — the same
    // guard test/web/fuel.test.ts satisfies.
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    handed = null;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
      }),
    );
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  /**
   * The real router, with the chat turn replaced by a recorder. Everything
   * before the turn — thread lookup, provider resolution from the thread's
   * agent, credential decryption, client construction — is the production
   * path.
   */
  const app = () =>
    appWithOrg(
      orgId,
      createThreadsRouter(db, {
        env: () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' }),
        chatTurn: async (_db, _orgId, thread, text, deps) => {
          handed = { thread, text, client: deps?.client ?? null };
          return { ok: true, reply: 'noted.', model: 'test', costed: true };
        },
      }),
    );

  const generalThread = () => createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });

  it('carries a real Anthropic client from the owner’s connected key into the turn', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0001');
    const thread = await generalThread();

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'is a subscription worth it?' }).expect(202);

    expect(handed?.text).toBe('is a subscription worth it?');
    expect(handed?.client).toBeInstanceOf(AnthropicLlmClient);
  });

  /**
   * THE PARITY QUESTION, in one test.
   *
   * Two keys connected, one thread. The client that arrives must follow the
   * agent the THREAD is on — not the org's first credential, and not a
   * default. If this passes, "work across every agent" is a real capability
   * and the roster is genuinely switchable.
   */
  it('follows the thread’s own agent when the owner has connected more than one key', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0001');
    await connectCredential(db, orgId, 'openai', 'sk-oai-test-0002');
    const thread = await generalThread();

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'first' }).expect(202);
    expect(handed?.client).toBeInstanceOf(AnthropicLlmClient);

    const switched = await switchThreadAgent(db, orgId, thread.id, 'gpt');
    expect(switched.ok).toBe(true);

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'second' }).expect(202);
    expect(handed?.client).toBeInstanceOf(OpenAiLlmClient);
  });

  /**
   * Every agent in the roster is wired to a real model, and the picker offers
   * all of them. Three of these used to say "not yet" while the server ran
   * them perfectly well, which is the sort of thing that teaches people the
   * product is smaller than it is.
   */
  it('gets a real client for every agent it offers', async () => {
    // Not "every agent is live" any more — a row may be declared ahead of its
    // driver. The property that matters is unchanged and stronger: anything
    // the picker OFFERS reaches a working client, which is why this walks the
    // real route rather than asserting a flag.
    for (const agent of AGENTS.filter((a) => a.live && !a.changesFiles)) {
      await connectCredential(db, orgId, agent.provider, `key-for-${agent.provider}`);
      const thread = await generalThread();
      await switchThreadAgent(db, orgId, thread.id, agent.id);
      await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'hello' }).expect(202);
      expect(handed?.client, agent.id).not.toBeNull();
    }
  });

  it('sends a thread to its own provider, not to whichever key came first', async () => {
    // The failure this guards is the quiet one: with several keys connected, a
    // thread on Kimi answering on Anthropic looks like it worked. Anthropic has
    // its own client class, so the two are distinguishable end to end.
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0001');
    await connectCredential(db, orgId, 'kimi', 'sk-moonshot-test-0001');

    const onKimi = await generalThread();
    await switchThreadAgent(db, orgId, onKimi.id, 'kimi');
    await request(app()).post(`/api/threads/${onKimi.id}/message`).send({ text: 'hello' }).expect(202);
    expect(handed?.client).toBeInstanceOf(OpenAiLlmClient);
    expect(handed?.client).not.toBeInstanceOf(AnthropicLlmClient);

    const onClaude = await generalThread();
    await request(app()).post(`/api/threads/${onClaude.id}/message`).send({ text: 'hello' }).expect(202);
    expect(handed?.client).toBeInstanceOf(AnthropicLlmClient);
  });

  /**
   * The honest null. A thread whose agent has no key connected gets no client
   * at all, so the turn says so plainly rather than quietly answering as
   * somebody else — the behaviour turn.test.ts already covers, reached here
   * through the real route.
   */
  it('hands over nothing when the thread’s agent has no key behind it', async () => {
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-test-0001');
    const thread = await generalThread();
    await switchThreadAgent(db, orgId, thread.id, 'gpt'); // openai, not connected

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'hello' }).expect(202);

    expect(handed?.client).toBeNull();
  });

  /**
   * THE WALL, GONE. This test was written the other way round a commit ago:
   * it asserted that a conversation could not move between talking and
   * building, which is the one boundary the product's headline feature exists
   * to cross.
   */
  it('moves a conversation between talking and building, both ways', async () => {
    const thread = await generalThread();

    const toBuilder = await switchThreadAgent(db, orgId, thread.id, 'claude-code');
    expect(toBuilder.ok).toBe(true);

    const workshop = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Build it' });
    const toTalker = await switchThreadAgent(db, orgId, workshop.id, 'claude');
    expect(toTalker.ok).toBe(true);
  });
});
