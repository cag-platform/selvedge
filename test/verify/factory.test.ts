import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, getCard, applyAction } from '../../src/server/cards/store.js';
import { verifyCardForOrg } from '../../src/server/verify/factory.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';
import type { CheckResult } from '../../src/server/verify/verdict.js';

const T = '2026-08-01T12:00:00Z';

function input(): ProposeInput {
  return {
    id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'x', proposal: 'x',
    signals: {}, estimate: { lowCents: 100, highCents: 500 }, capCents: 100000, now: T,
  };
}

async function driveToVerifying(db: TestDb) {
  await createCard(db, input());
  for (const a of [
    { type: 'approve' as const, at: T },
    { type: 'start_work' as const, at: T },
    { type: 'begin_verify' as const, at: T },
  ]) {
    await applyAction(db, 'org_1', 'card_1', a);
  }
}

const pass: CheckResult[] = [
  { kind: 'smoke', name: 'responds', outcome: 'pass' },
  { kind: 'acceptance', name: 'does what was asked', outcome: 'pass' },
];

describe('verifyCardForOrg — the verdict persisted through the machine', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('drives a verifying card to done with the verdict and summary persisted', async () => {
    await driveToVerifying(db);
    const res = await verifyCardForOrg(db, 'org_1', 'card_1', { now: () => new Date(T), runChecks: async () => pass });
    expect(res.outcome).toBe('completed');

    const persisted = await getCard(db, 'org_1', 'card_1');
    expect(persisted?.state).toBe('done');
    expect(persisted?.verdict).toBe('verified');
    expect(persisted?.acts.at(-1)!.detail).toMatch(/verified/i);
  });

  it('a verifier failure persists an honest inconclusive, not a crash', async () => {
    await driveToVerifying(db);
    const res = await verifyCardForOrg(db, 'org_1', 'card_1', {
      now: () => new Date(T),
      runChecks: async () => {
        throw new Error('checks unavailable');
      },
    });
    expect(res.outcome).toBe('completed');
    expect((await getCard(db, 'org_1', 'card_1'))?.verdict).toBe('inconclusive');
  });

  it('returns not_found for another org and runs nothing', async () => {
    await driveToVerifying(db);
    let ran = false;
    const res = await verifyCardForOrg(db, 'org_2', 'card_1', { runChecks: async () => { ran = true; return pass; } });
    expect(res.outcome).toBe('not_found');
    expect(ran).toBe(false);
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('verifying'); // untouched
  });
});
