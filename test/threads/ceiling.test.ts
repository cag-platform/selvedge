import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { createThread, getThread } from '../../src/server/threads/store.js';
import { threadCeiling } from '../../src/server/threads/ceiling.js';
import { setBuild } from '../../src/server/build/store.js';
import { defaultEstimateAndCap } from '../../src/server/cards/triggers.js';
import { appWithOrg } from '../web/helpers.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';

/**
 * NOTHING SPENDS PAST WHAT YOU APPROVED — in a conversation, at last.
 *
 * A work card has carried an estimate, a hard cap and checkpoint pauses since
 * it was written. A conversation carried none of them, and could take build
 * turn after build turn with nothing stopping it — while the Inbox made
 * conversations the primary way to work. The product's central sentence was
 * true on the path people didn't use.
 */
describe('what a conversation is allowed to spend', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' });
  const cap = defaultEstimateAndCap('live_small').capCents;

  let turns: number;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    turns = 0;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      }),
    );
    await setBuild(db, orgId, 'loom', { sandboxId: 'sbx_1' });
  });
  afterEach(async () => close());

  const app = () =>
    appWithOrg(
      orgId,
      createThreadsRouter(db, { lookup: stubRepoLookup,
        env: engineOn,
        runTurn: (async (_db, _org, _projectId, _text, cfg) => {
          turns += 1;
          return { runId: 'r', agent: cfg.agent, status: 'succeeded', costCents: 1, reply: 'ok', stagedChangesReady: false };
        }) as ThreadsDeps['runTurn'],
      }),
    );

  /** A building conversation that has already spent `cents`. */
  async function spent(cents: number) {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout' });
    if (cents > 0) {
      await db.insert(agentRuns).values({
        id: ulid(),
        orgId,
        projectId: 'loom',
        threadId: thread.id,
        agent: 'claude-code',
        prompt: 'turn: earlier work',
        status: 'succeeded',
        costCents: cents,
      });
    }
    return thread;
  }

  const send = (id: string, body: Record<string, unknown> = {}) =>
    request(app()).post(`/api/threads/${id}/message`).send({ text: 'keep going', ...body });

  it('lets a conversation work right up to what was agreed', async () => {
    const thread = await spent(cap - 1);
    await send(thread.id).expect(202);
    expect(turns).toBe(1);
  });

  /**
   * The stop itself. Not a wall and not a silent failure: the real number is
   * in the sentence, and it says plainly that nothing was lost.
   */
  it('stops at the ceiling, names the figure, and does not spend', async () => {
    const thread = await spent(cap);
    const res = await send(thread.id).expect(409);

    expect(turns).toBe(0);
    expect(res.body.error).toMatch(/where I said I'd stop/i);
    expect(res.body.error).toContain('$30.00');
    expect(res.body.error).toMatch(/nothing is lost/i);
    expect(res.body.spend_ceiling).toMatchObject({ spent_cents: cap, cap_cents: cap, raises: 0 });
  });

  /** A refusal with a way through — one word, and it carries on. */
  it('carries on when the owner says so, and lifts the ceiling by one more', async () => {
    const thread = await spent(cap);
    await send(thread.id).expect(409);

    await send(thread.id, { raise_cap: true }).expect(202);
    expect(turns).toBe(1);

    const after = await threadCeiling(db, orgId, (await getThread(db, orgId, thread.id))!);
    expect(after.raises).toBe(1);
    expect(after.capCents).toBe(cap * 2);
    expect(after.reached).toBe(false);
  });

  /**
   * A ceiling nobody can see being lifted is the same as no ceiling. The raise
   * goes on the conversation, in the record the export carries.
   */
  it('writes the raise onto the conversation, with both figures', async () => {
    const thread = await spent(cap);
    await send(thread.id, { raise_cap: true }).expect(202);

    const [line] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id), eq(agentMessages.role, 'switch')));

    expect(line!.content).toContain('$30.00');
    expect(line!.content).toContain('$60.00');
    expect(line!.content).toMatch(/you asked me to carry on/i);
    expect((line!.meta as { kind?: string }).kind).toBe('spend-ceiling-raised');
  });

  it('stops again at the new ceiling rather than staying lifted forever', async () => {
    const thread = await spent(cap);
    await send(thread.id, { raise_cap: true }).expect(202);

    // Spend up to the raised ceiling; it should stop once more.
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'turn: more work',
      status: 'succeeded',
      costCents: cap,
    });

    const res = await send(thread.id).expect(409);
    expect(res.body.spend_ceiling).toMatchObject({ cap_cents: cap * 2, raises: 1 });
  });

  /**
   * The policy is the CARDS' policy. If these two ever disagree about what a
   * project's stakes are worth, one of them is lying to the owner.
   */
  it('uses the same ceiling a work card would', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'sild', name: 'SILD', owner_description: 'Critical.' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
      }),
    );
    const thread = await createThread(db, orgId, 'sild', { kind: 'workshop', title: 'Rework' });

    const ceiling = await threadCeiling(db, orgId, thread);
    expect(ceiling.capCents).toBe(defaultEstimateAndCap('live_critical').capCents);
  });

  /** An unknown project is not a licence to spend. */
  it('applies the gentlest ceiling when there are no stated stakes', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Orphan' });
    const orphaned = { ...thread, projectId: null };

    const ceiling = await threadCeiling(db, orgId, orphaned);
    expect(ceiling.capCents).toBe(defaultEstimateAndCap('sandbox').capCents);
  });

  /**
   * Talking has its own daily allowance and does not touch a sandbox, so the
   * build ceiling has nothing to say about it.
   */
  it('says nothing about a conversation that is only talking', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Pricing' });
    await db.insert(agentRuns).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'turn: expensive history',
      status: 'succeeded',
      costCents: cap * 10,
    });

    await request(app()).post(`/api/threads/${thread.id}/message`).send({ text: 'what do you think?' }).expect(202);
  });
});
