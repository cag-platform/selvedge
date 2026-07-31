import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, getCard, applyAction } from '../../src/server/cards/store.js';
import { runCardForOrg } from '../../src/server/runner/factory.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';
import type { SandboxProvider } from '../../src/server/runner/types.js';

const T = '2026-07-31T12:00:00Z';

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request',
    title: 'x', proposal: 'x', signals: {}, estimate: { lowCents: 100, highCents: 500 },
    capCents: 100000, now: T, ...overrides,
  };
}

const sandbox: SandboxProvider = { create: async () => ({ id: 'sbx' }), destroy: async () => {} };

describe('runCardForOrg — the runner bound to a real persisted card', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('drives an approved card through work to verifying, persisted at each step', async () => {
    await createCard(db, input());
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });

    let calls = 0;
    const res = await runCardForOrg(db, 'org_1', 'card_1', {
      sandbox,
      now: () => new Date(T),
      agentStep: async () => {
        calls++;
        return calls === 1 ? { spentCents: 200, done: false, note: 'edited' } : { spentCents: 300, done: true, note: 'tested' };
      },
    });
    expect(res.outcome).toBe('ready_to_verify');

    // The persisted row reflects the whole run — not just the in-memory card.
    const persisted = await getCard(db, 'org_1', 'card_1');
    expect(persisted?.state).toBe('verifying');
    expect(persisted?.spentCents).toBe(500);
    expect(persisted?.acts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['work_started', 'verifying']),
    );
  });

  it('the cap holds against the DB: a run that exceeds the cap persists a stopped card', async () => {
    await createCard(db, input({ capCents: 1000 }));
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });
    const res = await runCardForOrg(db, 'org_1', 'card_1', {
      sandbox,
      now: () => new Date(T),
      agentStep: async () => ({ spentCents: 1500, done: false }),
    });
    expect(res.outcome).toBe('stopped');
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('stopped');
  });

  it('returns not_found for another org\'s card, running nothing', async () => {
    await createCard(db, input());
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });
    let called = false;
    const res = await runCardForOrg(db, 'org_2', 'card_1', {
      sandbox,
      agentStep: async () => { called = true; return { spentCents: 1, done: true }; },
    });
    expect(res.outcome).toBe('not_found');
    expect(called).toBe(false);
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('approved'); // untouched
  });
});
