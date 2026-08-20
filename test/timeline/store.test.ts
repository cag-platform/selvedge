import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, cards, narrations, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread, ensureWorkshopThread } from '../../src/server/threads/store.js';
import { projectTimeline, searchProject } from '../../src/server/timeline/store.js';

/**
 * The gate this phase is held to: answer "what happened to this project in the
 * last two weeks?" from the timeline alone, without opening a thread. So the
 * test builds a fortnight of a real project's life out of the rows the product
 * actually writes, and asks the timeline to tell the story back.
 */
describe('one project\'s history, in one list', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86_400_000 - hours * 3_600_000);

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'other', name: 'Other', owner_description: 'Something else.' } }));
  });
  afterEach(async () => close());

  it('merges asks, work, ships, switches and what the watching saw — newest first', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    await db.insert(cards).values({
      id: 'c1',
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: 'guest checkout',
      proposal: 'Let people buy without making an account.',
      risk: 'sensitive',
      gate: 'hard',
      state: 'done',
      verdict: 'verified',
      gradedBy: 'independent',
      estimate: {},
      stop: {},
      acts: [],
      spentCents: 320,
      createdAt: ago(9),
      updatedAt: ago(7),
    });
    await db.insert(agentRuns).values({
      id: 'r1',
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      agent: 'claude-code',
      prompt: 'ship: guest checkout',
      status: 'succeeded',
      commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      changedPaths: ['src/checkout/Cart.tsx'],
      createdAt: ago(7),
    });
    await db.insert(agentMessages).values({
      id: 's1',
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      role: 'switch',
      content: '⇄ continued with Codex — handoff 1.8k tokens, about $0.004',
      meta: { switch: { from: 'claude-code', to: 'codex', tokens: 1834, cost_usd: 0.0037, payload: null, pending: false } },
      createdAt: ago(3),
    });
    await db.insert(narrations).values({
      id: 'n1',
      orgId,
      projectId: 'loom',
      eventId: 'e1',
      eventType: 'runtime.error_spike',
      occurredAt: ago(2),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'PUSH',
      kind: 'attention',
      fragment: 'Checkout started failing just after last night\'s change.',
      verdict: 'users_affected',
    });

    const entries = await projectTimeline(db, orgId, 'loom');
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('ask');
    expect(kinds).toContain('verdict');
    expect(kinds).toContain('ship');
    expect(kinds).toContain('switch');
    expect(kinds).toContain('event');
    expect(kinds).toContain('thread');

    // Newest first, and the story reads in order without opening anything.
    const dates = entries.map((e) => e.at);
    expect([...dates].sort().reverse()).toEqual(dates);
    const story = entries.map((e) => e.sentence).join('\n');
    expect(story).toContain('guest checkout');
    expect(story).toContain('Checkout started failing');
    expect(story).toMatch(/passed from Claude Code to Codex/);

    // Exactly one entry carries the needs-you edge: the break. Everything else
    // is motion or a good outcome — the calm test, applied to history.
    expect(entries.filter((e) => e.status === 'needs')).toHaveLength(1);
  });

  it('honours the window: two weeks means two weeks', async () => {
    await db.insert(cards).values({
      id: 'old',
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: 'something from the spring',
      proposal: 'x',
      risk: 'ordinary',
      gate: 'normal',
      state: 'done',
      verdict: 'probably',
      estimate: {},
      stop: {},
      acts: [],
      createdAt: ago(90),
      updatedAt: ago(90),
    });
    await db.insert(cards).values({
      id: 'recent',
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: 'something this week',
      proposal: 'x',
      risk: 'ordinary',
      gate: 'normal',
      state: 'done',
      verdict: 'probably',
      estimate: {},
      stop: {},
      acts: [],
      createdAt: ago(3),
      updatedAt: ago(3),
    });

    const fortnight = await projectTimeline(db, orgId, 'loom', { since: ago(14) });
    expect(fortnight.map((e) => e.sentence).join('\n')).toContain('something this week');
    expect(fortnight.map((e) => e.sentence).join('\n')).not.toContain('from the spring');

    const everything = await projectTimeline(db, orgId, 'loom');
    expect(everything.map((e) => e.sentence).join('\n')).toContain('from the spring');
  });

  it('is one project\'s history, and one org\'s', async () => {
    await createThread(db, orgId, 'other', { kind: 'general', title: 'A different project entirely' });
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    expect(thread).toBeTruthy();

    const loom = await projectTimeline(db, orgId, 'loom');
    expect(loom.map((e) => e.sentence).join('\n')).not.toContain('A different project entirely');
    expect(await projectTimeline(db, 'org_2', 'loom')).toEqual([]);
  });

  it('a project with nothing in it says nothing, rather than inventing a start', async () => {
    expect(await projectTimeline(db, orgId, 'other')).toEqual([]);
  });

  it('stays bounded — three months of a busy project is still one readable list', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `c${i}`,
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: `change ${i}`,
      proposal: 'x',
      risk: 'ordinary',
      gate: 'normal',
      state: 'done',
      verdict: 'probably' as const,
      estimate: {},
      stop: {},
      acts: [],
      createdAt: ago(90 - i / 4),
      updatedAt: ago(90 - i / 4),
    }));
    await db.insert(cards).values(rows);

    const started = Date.now();
    const entries = await projectTimeline(db, orgId, 'loom');
    expect(entries.length).toBeLessThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(3000);
    // The cap keeps the newest, which is what "what happened lately" means.
    expect(entries[0]!.at.localeCompare(entries.at(-1)!.at)).toBeGreaterThan(0);
  });
});
