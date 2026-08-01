import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { proposeIncidentCard } from '../../src/server/cards/incident.js';
import { listCards, applyAction } from '../../src/server/cards/store.js';
import { ingestEvent, ingestResolvedEvent } from '../../src/server/resolution/ingest.js';

const NOW = new Date('2026-07-31T12:00:00Z');

describe('proposeIncidentCard — the proactive front of the loop', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const moneyPack = makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'a shop' },
    stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
    topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
  });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('mints a hard-gated fix card for a break on a money-touching live app', async () => {
    await createPack(db, orgId, moneyPack);
    const card = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    expect(card).not.toBeNull();
    expect(card!.trigger).toBe('incident');
    expect(card!.state).toBe('proposed');
    expect(card!.risk).toBe('sensitive'); // touches money → hard gate
    expect(card!.gate).toBe('hard');
  });

  it('mints at most one open incident card per project', async () => {
    await createPack(db, orgId, moneyPack);
    const first = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    const second = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.error_rate_spike', NOW);
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // deduped — one fix on the table at a time
    expect(await listCards(db, orgId, 'loom')).toHaveLength(1);
  });

  it('mints a fresh card again once the previous one is resolved', async () => {
    await createPack(db, orgId, moneyPack);
    const first = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    await applyAction(db, orgId, first!.id, { type: 'decline', at: NOW.toISOString() });
    const second = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    expect(second).not.toBeNull(); // the earlier one is terminal, so a new one is allowed
  });

  it('does not offer a fix card for a sandbox app', async () => {
    const sandbox = makeTestPack({
      identity: { project_id: 'toy', name: 'Toy', owner_description: 'x' },
      stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/toy', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, sandbox);
    expect(await proposeIncidentCard(db, orgId, 'toy', sandbox, 'runtime.health_failing', NOW)).toBeNull();
  });

  it('fires through the ingest path: a break event proposes a card', async () => {
    await createPack(db, orgId, moneyPack);
    // Health/deploy events reach ingest with their project already resolved
    // (the poller knows it) — the same path routeNarrateAndPersist runs.
    await ingestResolvedEvent(db, 'loom', {
      org_id: orgId,
      source: 'railway',
      source_account_id: 'acme/loom',
      event_type: 'runtime.health_failing',
      occurred_at: NOW.toISOString(),
      severity_hint: 'error',
      raw: {},
      dedupe_key: 'brk-1',
    });
    const cards = await listCards(db, orgId, 'loom');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.trigger).toBe('incident');
  });

  it('a repeat incident carries the memory of last time into the proposal', async () => {
    await createPack(db, orgId, moneyPack);
    // First occurrence, worked through to done.
    const first = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    for (const a of [
      { type: 'approve' as const, at: NOW.toISOString(), backupVerified: true },
      { type: 'start_work' as const, at: NOW.toISOString() },
      { type: 'spend' as const, at: NOW.toISOString(), cents: 650 },
      { type: 'begin_verify' as const, at: NOW.toISOString() },
      { type: 'complete' as const, at: NOW.toISOString(), verdict: 'verified' as const },
    ]) {
      await applyAction(db, orgId, first!.id, a);
    }

    // Same incident again → the proposal recalls the first.
    const second = await proposeIncidentCard(db, orgId, 'loom', moneyPack, 'runtime.health_failing', NOW);
    expect(second!.proposal).toMatch(/seen this one before/i);
    expect(second!.proposal).toMatch(/\$6\.50/); // last time's cost
  });

  it('a non-break event proposes nothing', async () => {
    await createPack(db, orgId, moneyPack);
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: NOW.toISOString(),
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'pr-1',
    });
    expect(await listCards(db, orgId, 'loom')).toHaveLength(0);
  });
});
