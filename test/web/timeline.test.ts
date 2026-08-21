import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, cards, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { createTimelineRouter } from '../../src/server/web/routes/timeline.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/timeline — the record, made visible', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    await db.insert(agentMessages).values({
      id: 'm1',
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      role: 'owner',
      content: 'the basket empties itself when you go back',
    });
    await db.insert(cards).values([
      {
        id: 'recent',
        orgId,
        projectId: 'loom',
        trigger: 'request',
        title: 'guest checkout',
        proposal: 'Let people buy without an account.',
        risk: 'ordinary',
        gate: 'normal',
        state: 'done',
        verdict: 'verified',
        estimate: {},
        stop: {},
        acts: [],
        createdAt: ago(3),
        updatedAt: ago(3),
      },
      {
        id: 'ancient',
        orgId,
        projectId: 'loom',
        trigger: 'request',
        title: 'a change from the spring',
        proposal: 'x',
        risk: 'ordinary',
        gate: 'normal',
        state: 'done',
        verdict: 'probably',
        estimate: {},
        stop: {},
        acts: [],
        createdAt: ago(120),
        updatedAt: ago(120),
      },
    ]);
  });
  afterEach(async () => close());

  const app = () => appWithOrg(orgId, createTimelineRouter(db));

  it('answers "what happened lately" with a fortnight by default', async () => {
    const res = await request(app()).get('/api/projects/loom/timeline');
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('Loom');
    expect(res.body.days).toBe(14);
    const story = res.body.entries.map((e: { sentence: string }) => e.sentence).join('\n');
    expect(story).toContain('guest checkout');
    expect(story).not.toContain('from the spring');
    // Every entry is one sentence with an edge and its evidence beneath it.
    for (const entry of res.body.entries) {
      expect(entry.sentence.length).toBeGreaterThan(0);
      expect(['healthy', 'working', 'needs', 'unknown']).toContain(entry.status);
      expect(Array.isArray(entry.evidence)).toBe(true);
    }
  });

  it('opens the window when asked, and never further than a year', async () => {
    const all = await request(app()).get('/api/projects/loom/timeline?days=0');
    expect(all.body.days).toBe(0);
    expect(all.body.entries.map((e: { sentence: string }) => e.sentence).join('\n')).toContain('from the spring');

    const silly = await request(app()).get('/api/projects/loom/timeline?days=99999');
    expect(silly.body.days).toBe(365);
    const junk = await request(app()).get('/api/projects/loom/timeline?days=nonsense');
    expect(junk.body.days).toBe(14);
  });

  it('searches the project and says where each hit came from', async () => {
    const res = await request(app()).get('/api/projects/loom/search?q=basket');
    expect(res.status).toBe(200);
    expect(res.body.hits[0]).toMatchObject({ kind: 'message', where: 'Checkout rework' });
    expect(res.body.hits[0].excerpt).toContain('basket');

    const empty = await request(app()).get('/api/projects/loom/search?q=');
    expect(empty.body.hits).toEqual([]);
  });

  it('is org-scoped, and a project that is not yours is not there', async () => {
    const otherOrg = appWithOrg('org_2', createTimelineRouter(db));
    expect((await request(otherOrg).get('/api/projects/loom/timeline')).status).toBe(404);
    expect((await request(otherOrg).get('/api/projects/loom/search?q=basket')).status).toBe(404);
    expect((await request(app()).get('/api/projects/nope/timeline')).status).toBe(404);
  });
});
