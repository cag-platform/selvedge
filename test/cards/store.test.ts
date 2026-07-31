import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, getCard, listCards, applyAction } from '../../src/server/cards/store.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';

const T = '2026-07-31T12:00:00Z';

function input(overrides: Partial<ProposeInput> = {}): ProposeInput {
  return {
    id: 'card_1',
    orgId: 'org_1',
    projectId: 'loom',
    trigger: 'request',
    title: 'Make the gift note optional',
    proposal: "I'd make the gift-note field optional at checkout.",
    signals: {},
    estimate: { lowCents: 400, highCents: 900 },
    capCents: 1500,
    now: T,
    ...overrides,
  };
}

describe('card store — persistence moves state only through the machine', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('creates a proposed card and reads it back with risk derived', async () => {
    const created = await createCard(db, input({ signals: { touchesPayments: true } }));
    expect(created.state).toBe('proposed');
    expect(created.risk).toBe('sensitive');
    expect(created.gate).toBe('hard');
    const fetched = await getCard(db, 'org_1', 'card_1');
    expect(fetched?.proposal).toBe(created.proposal);
    expect(fetched?.acts[0]!.kind).toBe('proposed');
  });

  it('a full approved→work→verify→done run persists at every step', async () => {
    await createCard(db, input());
    expect((await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T })).ok).toBe(true);
    expect((await applyAction(db, 'org_1', 'card_1', { type: 'start_work', at: T })).ok).toBe(true);
    expect((await applyAction(db, 'org_1', 'card_1', { type: 'spend', at: T, cents: 300 })).ok).toBe(true);
    await applyAction(db, 'org_1', 'card_1', { type: 'begin_verify', at: T });
    await applyAction(db, 'org_1', 'card_1', { type: 'complete', at: T, verdict: 'verified' });

    const done = await getCard(db, 'org_1', 'card_1');
    expect(done?.state).toBe('done');
    expect(done?.verdict).toBe('verified');
    expect(done?.spentCents).toBe(300);
  });

  it('the hard gate holds against the DB: a sensitive card is not approved without a backup, and nothing is written', async () => {
    await createCard(db, input({ signals: { touchesAuth: true } }));
    const r = await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('backup_required');
    // The row is untouched — still proposed.
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('proposed');
  });

  it('the cap holds against the DB: spending to the cap persists a stopped card', async () => {
    await createCard(db, input({ capCents: 1000 }));
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });
    await applyAction(db, 'org_1', 'card_1', { type: 'start_work', at: T });
    await applyAction(db, 'org_1', 'card_1', { type: 'spend', at: T, cents: 1000 });
    const stopped = await getCard(db, 'org_1', 'card_1');
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.verdict).toBe('stopped');
  });

  it('is org-scoped: another org can neither read nor act on the card', async () => {
    await createCard(db, input());
    expect(await getCard(db, 'org_2', 'card_1')).toBeNull();
    const r = await applyAction(db, 'org_2', 'card_1', { type: 'approve', at: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');
    // The real owner's card is untouched.
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('proposed');
  });

  it('lists newest first, filterable by project', async () => {
    await createCard(db, input({ id: 'card_1', projectId: 'loom', now: '2026-07-31T10:00:00Z' }));
    await createCard(db, input({ id: 'card_2', projectId: 'mirror', now: '2026-07-31T11:00:00Z' }));
    const all = await listCards(db, 'org_1');
    expect(all.map((c) => c.id)).toEqual(['card_2', 'card_1']); // newest first
    const loomOnly = await listCards(db, 'org_1', 'loom');
    expect(loomOnly.map((c) => c.id)).toEqual(['card_1']);
  });
});
