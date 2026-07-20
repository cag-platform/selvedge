import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { sweepOrgForStalls, runStallSweep } from '../../src/server/resolution/stallSweep.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('resolution/stallSweep', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const now = new Date('2026-07-19T00:00:00Z');

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });

  afterEach(async () => {
    await close();
  });

  it('moves an in_progress item quiet for 14+ days to stalled and ingests a code.branch_stalled event', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      state: {
        in_progress: [
          { ref: 'feature/old', summary: 'old work', opened_at: '2026-06-01T00:00:00Z', last_activity_at: '2026-07-01T00:00:00Z' },
          { ref: 'feature/fresh', summary: 'fresh work', opened_at: '2026-07-18T00:00:00Z', last_activity_at: '2026-07-18T00:00:00Z' },
        ],
      },
    });
    await createPack(db, orgId, pack);

    const stalledCount = await sweepOrgForStalls(db, orgId, now);
    expect(stalledCount).toBe(1);

    const updated = await getPack(db, orgId, 'loom');
    expect(updated?.state?.in_progress?.map((i) => i.ref)).toEqual(['feature/fresh']);
    expect(updated?.state?.stalled?.map((i) => i.ref)).toEqual(['feature/old']);
  });

  it('is a no-op for packs with no stale items', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'toile', name: 'Toile', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/toile', role: 'source_of_truth' }] },
      state: { in_progress: [{ ref: 'x', opened_at: '2026-07-18T00:00:00Z', last_activity_at: '2026-07-18T00:00:00Z' }] },
    });
    await createPack(db, orgId, pack);
    expect(await sweepOrgForStalls(db, orgId, now)).toBe(0);
  });

  it('runStallSweep iterates every org', async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    const pack1 = makeTestPack({
      identity: { project_id: 'p1', name: 'P1', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'a/p1', role: 'source_of_truth' }] },
      state: { in_progress: [{ ref: 'x', last_activity_at: '2026-06-01T00:00:00Z' }] },
    });
    const pack2 = makeTestPack({
      identity: { project_id: 'p2', name: 'P2', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'a/p2', role: 'source_of_truth' }] },
      state: { in_progress: [{ ref: 'y', last_activity_at: '2026-06-01T00:00:00Z' }] },
    });
    await createPack(db, orgId, pack1);
    await createPack(db, 'org_2', pack2);

    expect(await runStallSweep(db, now)).toBe(2);
  });
});
