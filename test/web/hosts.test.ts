import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createHostsRouter } from '../../src/server/web/routes/hosts.js';
import { resolveRailwayToken } from '../../src/server/connectors/railway/resolve.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/hosts — grant Selvedge a token to watch deploys', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  const app = (id = orgId) => appWithOrg(id, createHostsRouter(db));

  it('connects a railway token that the deploy poller can then resolve', async () => {
    const res = await request(app()).post('/api/hosts').send({ provider: 'railway', token: 'rw-secret-token' });
    expect(res.status).toBe(200);
    expect(res.body.connected.provider).toBe('railway');
    expect(res.body.connected).not.toHaveProperty('token'); // secret never echoed
    // The token is now resolvable by the poller's discovery.
    expect(await resolveRailwayToken(db, orgId)).toBe('rw-secret-token');
  });

  it('lists connected hosts as last-four + status, never the secret', async () => {
    await request(app()).post('/api/hosts').send({ provider: 'supabase', token: 'sb-secret-token' });
    const res = await request(app()).get('/api/hosts');
    expect(res.body.connected).toHaveLength(1);
    expect(res.body.connected[0].provider).toBe('supabase');
    expect(res.body.connected[0]).not.toHaveProperty('valueEnc');
  });

  it('rejects an unknown host and a too-short token', async () => {
    expect((await request(app()).post('/api/hosts').send({ provider: 'heroku', token: 'x'.repeat(20) })).status).toBe(400);
    expect((await request(app()).post('/api/hosts').send({ provider: 'railway', token: 'short' })).status).toBe(400);
  });

  it('revokes a host token', async () => {
    await request(app()).post('/api/hosts').send({ provider: 'railway', token: 'rw-secret-token' });
    const res = await request(app()).delete('/api/hosts/railway');
    expect(res.body.removed).toBe(true);
    expect(await resolveRailwayToken(db, orgId)).toBeNull();
  });

  it('is org-scoped: one org never sees or resolves another org\'s host token', async () => {
    await request(app('org_1')).post('/api/hosts').send({ provider: 'railway', token: 'org1-token' });
    const other = await request(app('org_2')).get('/api/hosts');
    expect(other.body.connected).toHaveLength(0);
    expect(await resolveRailwayToken(db, 'org_2')).toBeNull();
  });
});
