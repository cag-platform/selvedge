import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, cards, narrations, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { searchProject } from '../../src/server/timeline/store.js';

/**
 * Search inside a project: what was said in its conversations, what was asked
 * of it, and what the watching reported. Nothing clever — the point is that a
 * thing you remember saying three months ago is findable, which is most of what
 * "the record is the product" means in practice.
 */
describe('searching inside a project', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    await db.insert(agentMessages).values([
      {
        id: 'm1',
        orgId,
        projectId: 'loom',
        threadId: thread.id,
        role: 'owner',
        content: 'A customer said the basket emptied itself when she went back to change a fabric.',
      },
      {
        id: 'm2',
        orgId,
        projectId: 'loom',
        threadId: thread.id,
        role: 'agent',
        content: 'The cart and the checkout were validating baskets differently. They now share one set of rules.',
      },
    ]);
    await db.insert(cards).values({
      id: 'c1',
      orgId,
      projectId: 'loom',
      trigger: 'request',
      title: 'guest checkout',
      proposal: 'Let people buy without making an account.',
      risk: 'ordinary',
      gate: 'normal',
      state: 'done',
      verdict: 'verified',
      estimate: {},
      stop: {},
      acts: [],
    });
    await db.insert(narrations).values({
      id: 'n1',
      orgId,
      projectId: 'loom',
      eventId: 'e1',
      eventType: 'runtime.error_spike',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      fragment: 'Checkout started failing just after last night\'s change.',
      verdict: 'users_affected',
    });
  });
  afterEach(async () => close());

  it('finds what was said in a conversation, and says which one', async () => {
    const hits = await searchProject(db, orgId, 'loom', 'basket');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.kind === 'message')).toBe(true);
    expect(hits[0]!.where).toBe('Checkout rework');
    expect(hits.map((h) => h.excerpt).join(' ')).toContain('emptied itself');
  });

  it('finds the half-word people actually type', async () => {
    // "check" is not a word in any of these rows; it is the prefix of one, and
    // a search box that fails here feels broken however good its stemming is.
    const hits = await searchProject(db, orgId, 'loom', 'check');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.excerpt + h.where).join(' ')).toMatch(/checkout/i);
  });

  it('finds a different form of the same word', async () => {
    // ...and the other half: full-text does the stemming containment can't.
    const hits = await searchProject(db, orgId, 'loom', 'failing');
    expect(hits.some((h) => h.kind === 'event')).toBe(true);
  });

  it('searches asks as well as conversations', async () => {
    const hits = await searchProject(db, orgId, 'loom', 'without making an account');
    expect(hits.some((h) => h.kind === 'card' && h.where === 'guest checkout')).toBe(true);
  });

  it('is scoped to one project and one org', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'other', name: 'Other', owner_description: 'x' } }));
    expect(await searchProject(db, orgId, 'other', 'basket')).toEqual([]);
    expect(await searchProject(db, 'org_2', 'loom', 'basket')).toEqual([]);
  });

  it('a query too short to mean anything returns nothing, rather than everything', async () => {
    expect(await searchProject(db, orgId, 'loom', 'a')).toEqual([]);
    expect(await searchProject(db, orgId, 'loom', '   ')).toEqual([]);
  });

  it('a wildcard is text, not a pattern — nobody can search their way to everything', async () => {
    expect(await searchProject(db, orgId, 'loom', '%%')).toEqual([]);
    expect(await searchProject(db, orgId, 'loom', '_a_')).toEqual([]);
  });

  it('finds nothing when there is nothing, and says so by saying nothing', async () => {
    expect(await searchProject(db, orgId, 'loom', 'zeppelin')).toEqual([]);
  });
});
