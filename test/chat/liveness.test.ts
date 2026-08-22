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
 * That question matters because three of the four agents in the registry are
 * marked `live: false`, and the whole product thesis — one place to work
 * across every agent — rests on whether that flag is a capability limit or a
 * label. These tests answer it: the route is exercised over HTTP, and the
 * client the chat turn receives is inspected rather than stubbed away.
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
   * `live: false` is a client-side label, not a server-side gate. GPT is
   * marked not-live in the registry; the server runs it anyway, given a key.
   * This is the test that says the wall in the picker is cosmetic.
   */
  it('does not refuse an agent the registry marks “not yet”', async () => {
    expect(AGENTS.find((a) => a.id === 'gpt')?.live).toBe(false);

    await connectCredential(db, orgId, 'openai', 'sk-oai-test-0002');
    const thread = await generalThread();
    await switchThreadAgent(db, orgId, thread.id, 'gpt');

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'hello' }).expect(202);

    expect(handed?.client).toBeInstanceOf(OpenAiLlmClient);
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
   * THE WALL, stated as a test so removing it has something to fail against.
   *
   * A coding agent cannot join a chat thread. The product's headline feature
   * is switching agents mid-thread, and this is the boundary that matters —
   * moving between talking and building — which is exactly where it is
   * refused. When the wall comes down this expectation inverts, and that will
   * be the diff worth reading.
   */
  it('refuses to move a conversation between talking and building — today', async () => {
    const thread = await generalThread();

    const toBuilder = await switchThreadAgent(db, orgId, thread.id, 'claude-code');
    expect(toBuilder.ok).toBe(false);
    if (!toBuilder.ok) {
      expect(toBuilder.reason).toBe('wrong_kind');
      expect(toBuilder.message).toContain('workshop thread');
    }

    const workshop = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Build it' });
    const toChat = await switchThreadAgent(db, orgId, workshop.id, 'claude');
    expect(toChat.ok).toBe(false);
    if (!toChat.ok) expect(toChat.reason).toBe('wrong_kind');
  });
});
