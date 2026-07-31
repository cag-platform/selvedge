import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { createProtectionRouter } from '../../src/server/web/routes/protection.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/protection — the connect-time brief, end to end', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'a shop' },
        stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it('code-only app: names the runtime and data blind spots, points at data first', async () => {
    const app = appWithOrg(orgId, createProtectionRouter(db));
    const res = await request(app).get('/api/projects/loom/protection-brief');
    expect(res.status).toBe(200);
    expect(res.body.brief.confidence).toBe('partial');
    expect(res.body.brief.nextStep).toMatch(/data/i);
    expect(res.body.brief.coverage.find((c: { area: string }) => c.area === 'code').connected).toBe(true);
    expect(res.body.brief.coverage.find((c: { area: string }) => c.area === 'data').connected).toBe(false);
  });

  it('coverage rises as the customer connects their host and data', async () => {
    await connectCredential(db, orgId, 'railway', 'org-railway-token');
    await connectCredential(db, orgId, 'supabase', 'org-supabase-token');
    const app = appWithOrg(orgId, createProtectionRouter(db));
    const res = await request(app).get('/api/projects/loom/protection-brief');
    expect(res.body.brief.confidence).toBe('high');
    expect(res.body.brief.blindSpots).toEqual([]);
    expect(res.body.brief.headline).toMatch(/watching all of Loom/i);
  });

  it("does not credit another org's connections", async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    await connectCredential(db, 'org_2', 'railway', 'other-org-token');
    const app = appWithOrg(orgId, createProtectionRouter(db));
    const res = await request(app).get('/api/projects/loom/protection-brief');
    // org_1's app is still runtime-blind; org_2's Railway token must not count.
    expect(res.body.brief.coverage.find((c: { area: string }) => c.area === 'runtime').connected).toBe(false);
  });

  it('404s for an app that has no pack', async () => {
    const app = appWithOrg(orgId, createProtectionRouter(db));
    expect((await request(app).get('/api/projects/ghost/protection-brief')).status).toBe(404);
  });
});
