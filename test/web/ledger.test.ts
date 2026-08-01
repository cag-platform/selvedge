import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, applyAction } from '../../src/server/cards/store.js';
import { createLedgerRouter } from '../../src/server/web/routes/ledger.js';
import { appWithOrg } from './helpers.js';

const T = '2026-08-01T12:00:00Z';

async function complete(db: TestDb, id: string, cents: number) {
  await createCard(db, {
    id, orgId: 'org_1', projectId: 'loom', trigger: 'request', title: `change ${id}`, proposal: 'x',
    signals: {}, estimate: { lowCents: 100, highCents: 500 }, capCents: 5000, now: T,
  });
  await applyAction(db, 'org_1', id, { type: 'approve', at: T });
  await applyAction(db, 'org_1', id, { type: 'start_work', at: T });
  await applyAction(db, 'org_1', id, { type: 'spend', at: T, cents });
  await applyAction(db, 'org_1', id, { type: 'begin_verify', at: T });
  await applyAction(db, 'org_1', id, { type: 'complete', at: T, verdict: 'verified' });
}

describe('web/routes/ledger — the track record', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('returns finished changes with the honest summary', async () => {
    await complete(db, 'c1', 500);
    await complete(db, 'c2', 700);
    await createCard(db, {
      id: 'c3', orgId, projectId: 'loom', trigger: 'request', title: 'open one', proposal: 'x',
      signals: {}, estimate: { lowCents: 1, highCents: 2 }, capCents: 1000, now: T,
    }); // still proposed → not in the ledger

    const res = await request(appWithOrg(orgId, createLedgerRouter(db))).get('/api/ledger');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.summary).toMatchObject({ total: 2, shipped: 2, spentCents: 1200 });
  });

  it('is org-scoped', async () => {
    await complete(db, 'c1', 500);
    const res = await request(appWithOrg('org_2', createLedgerRouter(db))).get('/api/ledger');
    expect(res.body.entries).toHaveLength(0);
    expect(res.body.summary.total).toBe(0);
  });
});
