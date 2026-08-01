import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, applyAction } from '../../src/server/cards/store.js';
import { listLedger, estimateForChange } from '../../src/server/ledger/store.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';

const T = '2026-08-01T12:00:00Z';

function input(id: string, overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    id, orgId: 'org_1', projectId: 'loom', trigger: 'request', title: `change ${id}`, proposal: 'x',
    signals: {}, estimate: { lowCents: 300, highCents: 1200 }, capCents: 3000, now: T, ...overrides,
  };
}

/** Create a card and drive it to done with a given spend. */
async function completeCard(db: TestDb, id: string, cents: number, overrides: Partial<ProposeInput> = {}) {
  await createCard(db, input(id, overrides));
  await applyAction(db, 'org_1', id, { type: 'approve', at: T, backupVerified: true });
  await applyAction(db, 'org_1', id, { type: 'start_work', at: T });
  if (cents > 0) await applyAction(db, 'org_1', id, { type: 'spend', at: T, cents });
  await applyAction(db, 'org_1', id, { type: 'begin_verify', at: T });
  await applyAction(db, 'org_1', id, { type: 'complete', at: T, verdict: 'verified' });
}

describe('ledger store — finished cards become the record', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('lists only finished cards, org-scoped, newest first', async () => {
    await completeCard(db, 'c1', 500);
    await createCard(db, input('c2')); // still proposed — not in the ledger
    const entries = await listLedger(db, 'org_1');
    expect(entries.map((e) => e.cardId)).toEqual(['c1']);
    expect(entries[0]!.spentCents).toBe(500);
    expect(await listLedger(db, 'org_2')).toHaveLength(0); // isolation
  });

  it('the flywheel: a repeat change is quoted from what the last ones cost', async () => {
    // Cold start uses the default.
    const cold = await estimateForChange(db, 'org_1', 'loom', 'ordinary', {
      estimate: { lowCents: 300, highCents: 1200 },
      capCents: 3000,
    });
    expect(cold.basis).toBe('default');

    // Three comparable ordinary changes land in the ledger.
    await completeCard(db, 'c1', 800);
    await completeCard(db, 'c2', 900);
    await completeCard(db, 'c3', 1000);

    const warm = await estimateForChange(db, 'org_1', 'loom', 'ordinary', {
      estimate: { lowCents: 300, highCents: 1200 },
      capCents: 3000,
    });
    expect(warm.basis).toBe('history'); // now learned, not guessed
    expect(warm.samples).toBe(3);
    expect(warm.estimate.lowCents).toBeGreaterThan(300); // tightened toward the real ~$8–10
  });
});
