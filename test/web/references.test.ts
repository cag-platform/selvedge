import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { ensureWorkshopThread, createThread } from '../../src/server/threads/store.js';
import { appWithOrg } from './helpers.js';

/**
 * The whole point of a reference: a conversation about one thing can read
 * another. What matters at this seam is that the material actually reaches the
 * turn, and that the owner can see it did — context arriving invisibly is
 * indistinguishable from a model guessing well.
 */
describe('web/routes/threads — #references reach the turn', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c' });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }]);
    for (const [id, name, desc] of [
      ['loom', 'Loom', 'The curtain shop storefront.'],
      ['mirror', 'Mirror', 'The admin dashboard.'],
    ]) {
      await createPack(
        db,
        orgId,
        makeTestPack({
          identity: { project_id: id!, name: name!, owner_description: desc! },
          topology: { sources: [{ connector: 'github', resource_id: `acme/${id}`, role: 'source_of_truth' }] },
        }),
      );
    }
  });
  afterEach(async () => {
    await close();
  });

  /**
   * A turn is fired and forgotten (the route answers 202 immediately, which is
   * the whole design), so what it was handed arrives a tick later. Waiting on
   * the call rather than on a sleep keeps this a test of the wiring and not of
   * the scheduler.
   */
  type TurnOptions = { handoff?: string; referenceNote?: string };
  function captureTurn() {
    let seen: ((value: TurnOptions) => void) | null = null;
    const called = new Promise<TurnOptions>((resolve) => {
      seen = resolve;
    });
    const runTurn = (async (_db: unknown, _org: unknown, _project: unknown, _text: unknown, _cfg: unknown, options?: TurnOptions) => {
      seen?.(options ?? {});
      return { runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false };
    }) as ThreadsDeps['runTurn'];
    return { runTurn, called };
  }

  const linesOf = async (threadId: string) =>
    db.select().from(agentMessages).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, threadId))).orderBy(agentMessages.createdAt);

  it('hands a build turn what the other project is, and says so on the thread', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'mirror');
    const { runTurn, called } = captureTurn();
    const app = appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));

    const res = await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'match how #loom does refunds' });
    expect(res.status).toBe(202);
    const options = await called;

    expect(options.handoff).toContain('The curtain shop storefront');
    // The builder must not read a reference as an instruction.
    expect(options.handoff).toContain('None of this is what they are asking you to change');
    // And the line the owner will see travels with the turn, which writes it
    // beneath the ask — see the ordering test below for the row itself.
    expect(options.referenceNote).toContain('Loom');
    expect(options.referenceNote).toContain('nothing there was changed');
  });

  it('puts the note under the ask, never above it', async () => {
    // Ordering is the difference between "here is what I read for that" and a
    // line that appears to be about the previous message.
    const thread = await ensureWorkshopThread(db, orgId, 'mirror');
    const deps: ThreadsDeps = {
      env: engineOn,
      runTurn: (async () => ({ runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false })) as ThreadsDeps['runTurn'],
    };
    const app = appWithOrg(orgId, createThreadsRouter(db, deps));
    await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'like #loom' });

    // The real runTurn writes both rows; the stub above writes neither, so this
    // asserts on the path that does: a chat turn.
    const chat = await createThread(db, orgId, 'mirror', { kind: 'general', title: 'Thinking', agent: 'claude' });
    const chatApp = appWithOrg(
      orgId,
      createThreadsRouter(db, {
        env: engineOn,
        chatTurn: (async () => ({ ok: true, reply: 'sure', model: 'm', costed: false })) as ThreadsDeps['chatTurn'],
      }),
    );
    await request(chatApp).post(`/api/threads/${chat.id}/message`).send({ text: 'compare with #loom' });
    // The stubbed chatTurn writes nothing either — so assert the route's own
    // consultation path, which writes both rows itself, in order.
    const consulted = await createThread(db, orgId, 'mirror', { kind: 'general', title: 'Panel', agent: 'claude' });
    await request(chatApp).post(`/api/threads/${consulted.id}/message`).send({ text: '@claude @gpt what about #loom?' });

    const said = await linesOf(consulted.id);
    const owner = said.findIndex((m) => m.role === 'owner');
    const note = said.findIndex((m) => m.role === 'switch' && m.content.includes('reading'));
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThan(owner);
  });

  it('marks an imported conversation as imported on the thread itself', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'mirror');
    const imported = ulid();
    await db.insert(threads).values({
      id: imported,
      orgId,
      kind: 'general',
      title: 'app ideas',
      agent: 'claude',
      projectId: 'loom',
      importedFrom: 'chatgpt',
      importSourceId: 'x1',
    });
    await db.insert(agentMessages).values({ id: ulid(), orgId, threadId: imported, role: 'owner', content: 'what would make it useful?' });

    const { runTurn, called } = captureTurn();
    const app = appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));
    await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'build on #"app ideas"' });
    const options = await called;

    expect(options.handoff).toContain('imported from ChatGPT');
    expect(options.referenceNote).toContain('imported from ChatGPT');
  });

  it('says nothing when a message references nothing', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'mirror');
    const { runTurn, called } = captureTurn();
    const app = appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));
    await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'just build the thing' });
    const options = await called;
    expect(options.handoff).toBeUndefined();
    expect(options.referenceNote).toBeUndefined();
    expect((await linesOf(thread.id)).filter((m) => m.role === 'switch')).toHaveLength(0);
  });
});
