import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage, narrations, digests } from '../../src/server/db/schema/index.js';
import { createAdminRouter } from '../../src/server/web/routes/admin.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/admin (gates 2 + 5)', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_b' }]);
  });
  afterEach(async () => close());

  it('reports cost per day with the budget flag, org-scoped', async () => {
    await db.insert(llmUsage).values([
      { id: ulid(), orgId, purpose: 'fragment', model: 'claude-sonnet-5', tokensIn: 1000, tokensOut: 100, costUsd: 0.004, ok: 'true' },
      { id: ulid(), orgId, purpose: 'compose', model: 'claude-fable-5', tokensIn: 3000, tokensOut: 400, costUsd: 0.2, ok: 'true' },
      { id: ulid(), orgId: 'org_b', purpose: 'compose', model: 'claude-fable-5', tokensIn: 9000, tokensOut: 900, costUsd: 9.9, ok: 'true' },
    ]);

    const app = appWithOrg(orgId, createAdminRouter(db));
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body.budget_usd_per_day).toBeCloseTo(0.15);
    expect(res.body.cost_by_day).toHaveLength(1);
    expect(res.body.cost_by_day[0].cost_usd).toBeCloseTo(0.204);
    expect(res.body.cost_by_day[0].over_budget).toBe(true); // flagged, not blocked
  });

  it('computes lib_hit_rate from narrations.meta', async () => {
    const base = {
      orgId,
      projectId: 'loom',
      eventType: 'build.succeeded',
      occurredAt: new Date(),
      path: 'LIB',
      intendedPath: 'LIB',
      delivery: 'DIGEST',
      fragment: 'x',
    };
    await db.insert(narrations).values([
      { ...base, id: ulid(), eventId: 'e1', meta: { lib_hit: true } },
      { ...base, id: ulid(), eventId: 'e2', meta: { lib_hit: true } },
      { ...base, id: ulid(), eventId: 'e3', path: 'LLM', meta: { lib_hit: false } },
      { ...base, id: ulid(), eventId: 'e4', intendedPath: 'LLM', path: 'LLM', meta: {} }, // not LIB-routed; excluded
    ]);

    const app = appWithOrg(orgId, createAdminRouter(db));
    const res = await request(app).get('/api/admin/metrics');
    expect(res.body.lib_hit_rate_by_day).toHaveLength(1);
    expect(res.body.lib_hit_rate_by_day[0].lib_routed).toBe(3);
    expect(res.body.lib_hit_rate_by_day[0].lib_hits).toBe(2);
    expect(res.body.lib_hit_rate_by_day[0].hit_rate).toBeCloseTo(2 / 3);
  });

  it('serves before/after digest pairs (mechanical vs composed)', async () => {
    await db.insert(digests).values({
      id: ulid(),
      orgId,
      digestDate: '2026-07-20',
      headline: 'h',
      sections: { attention: [], moved: [], standing: [], quiet: '', today: null },
      openThreads: [],
      renderedText: 'the composed brief',
      voice: 'composed',
      mechanicalText: 'the mechanical digest',
    });

    const app = appWithOrg(orgId, createAdminRouter(db));
    const res = await request(app).get('/api/admin/digests');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].composed_text).toBe('the composed brief');
    expect(res.body[0].mechanical_text).toBe('the mechanical digest');
  });
});
