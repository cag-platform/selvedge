import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { runChatTurn } from '../../src/server/chat/turn.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';

/**
 * A long paste is the ordinary case for a thinking thread — you put a piece of
 * work in and ask what somebody makes of it. Handing the model the opening
 * paragraph and asking it to analyse the whole is how you get a confident
 * answer about a fragment, which is the failure this codebase cares about most.
 */
describe('chat/turn — a long message survives the trip to the model', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => {
    await close();
  });

  const ok = () => new FakeLlmClient(() => ({ ok: true, json: { reply: 'Right.' }, tokensIn: 10, tokensOut: 10, model: 'm' }));

  it('carries the whole question, not its opening paragraph', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Thinking', agent: 'claude' });
    // Long enough that the old 1,500-character clip would have cut it, with a
    // marker at the end that only survives if the whole thing went.
    const rundown = `${'The house style is worth preserving. '.repeat(400)}THE LAST LINE MATTERS.`;
    expect(rundown.length).toBeGreaterThan(10_000);

    const client = ok();
    await runChatTurn(db, orgId, thread, rundown, { client });

    const sent = JSON.stringify(client.requests);
    expect(sent).toContain('THE LAST LINE MATTERS');
  });

  it('still bounds a conversation that has grown huge', async () => {
    // Room for the question is not licence for the whole history: a thread with
    // forty long turns in it must not grow the prompt without limit.
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Long one', agent: 'claude' });
    for (let i = 0; i < 30; i++) {
      await db.insert(agentMessages).values({
        id: ulid(),
        orgId,
        threadId: thread.id,
        role: i % 2 === 0 ? 'owner' : 'agent',
        content: `turn ${i} ${'padding '.repeat(600)}`,
      });
    }

    const client = ok();
    await runChatTurn(db, orgId, thread, 'so what do you think?', { client });
    const content = client.requests[0]!.userContent;
    expect(content.length).toBeLessThan(80_000);
    // And the newest turns are the ones that survived.
    expect(content).toContain('so what do you think?');
  });

  describe('when there is no answer, it says which kind of no', () => {
    // "I couldn't get an answer just then" is true and useless: it sends
    // somebody to retry a request that will fail identically, and hides the two
    // failures they could act on.
    const failing = (reason: string) =>
      new FakeLlmClient(() => ({ ok: false, reason, tokensIn: 5, tokensOut: 0, model: 'm' }));

    async function replyFor(reason: string) {
      const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: `T ${reason}`, agent: 'claude' });
      const outcome = await runChatTurn(db, orgId, thread, 'what do you make of this?', { client: failing(reason) });
      return outcome.ok ? '' : outcome.message;
    }

    it('names the one the owner can act on: the answer was too long', async () => {
      const message = await replyFor('max_tokens');
      expect(message).toContain('ran longer than I allow');
      expect(message).toContain('shorter');
    });

    it('names a rate limit as a wait rather than a fault', async () => {
      expect(await replyFor('api_error_429')).toContain('rate-limiting');
    });

    it('names a refusal as a refusal', async () => {
      expect(await replyFor('refusal')).toContain('declined');
    });

    it('falls back to the plain sentence for anything it cannot name', async () => {
      expect(await replyFor('something_new')).toContain("couldn't get an answer just then");
    });
  });
});
