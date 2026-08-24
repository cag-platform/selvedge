import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { ensureWorkshopThread, getThread, renameThread } from '../../src/server/threads/store.js';
import { appWithOrg } from './helpers.js';

/**
 * TWELVE ROWS READING "WORKSHOP".
 *
 * Every workshop thread is created as "Workshop" and every idea as "New
 * thread", and nothing ever renamed them. Invisible while the rail showed only
 * project names — and the moment the rail started showing what a place IS, it
 * showed a column of identical words, exactly as useful as the blank line it
 * replaced.
 *
 * The first thing the owner says names the room. Asserted through the route
 * rather than the helper, because the helper being right is not the claim: the
 * claim is that sending a message renames the thread, and there are three
 * paths through that route which write an owner message.
 */
describe('a conversation is named by what is said in it', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ daytonaApiKey: 'd' });

  const runTurn = (async () => ({
    runId: 'r',
    agent: 'claude-code',
    status: 'succeeded',
    costCents: 0,
    reply: 'ok',
    stagedChangesReady: false,
  })) as ThreadsDeps['runTurn'];

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

  const app = () => appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));
  const say = (threadId: string, text: string) => request(app()).post(`/api/threads/${threadId}/message`).send({ text });

  it('names the thread after the first thing said in it', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    expect(thread.title).toBe('Workshop');

    await say(thread.id, 'Give me a rundown of this app');

    expect((await getThread(db, orgId, thread.id))?.title).toBe('Give me a rundown of this app');
  });

  /** A conversation that renamed itself on every message would be unusable. */
  it('and never renames it again', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await say(thread.id, 'Give me a rundown of this app');
    await say(thread.id, 'now make the whole checkout one page');

    expect((await getThread(db, orgId, thread.id))?.title).toBe('Give me a rundown of this app');
  });

  /** This fills a blank. It never overwrites a decision somebody made. */
  it('leaves a name the owner chose alone', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await renameThread(db, orgId, thread.id, 'Checkout rework');

    await say(thread.id, 'Give me a rundown of this app');

    expect((await getThread(db, orgId, thread.id))?.title).toBe('Checkout rework');
  });

  it('cuts a long opening message on a word boundary', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await say(
      thread.id,
      'I need you to look at the checkout flow and work out why the basket empties itself when somebody changes a fabric',
    );

    const title = (await getThread(db, orgId, thread.id))?.title ?? '';
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title).toContain('I need you to look at the checkout flow');
  });

  /**
   * The rename is a courtesy on top of the turn, not part of it. If naming
   * were ever able to fail the request, a title would be able to stop somebody
   * talking to their own project.
   */
  it('still delivers the message when there is nothing to name it', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    // A message made entirely of an @mention: real, routable, and no words.
    const res = await say(thread.id, '@claudecode');
    expect(res.status).toBeLessThan(400);
    expect((await getThread(db, orgId, thread.id))?.title).toBe('@claudecode');
  });
});
