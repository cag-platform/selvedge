import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createFuelRouter, type FuelVerifier } from '../../src/server/web/routes/fuel.js';
import { listConnected } from '../../src/server/connectors/credentials/store.js';
import { appWithOrg } from './helpers.js';

const KEY = 'sk-ant-api03-abcdefghijklmnop';
const alwaysLive: FuelVerifier = async () => true;
const neverLive: FuelVerifier = async () => false;

describe('web/routes/fuel — the BYO connect experience', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it('connects a verified key and reports it without ever echoing the secret', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    const res = await request(app).post('/api/fuel').send({ provider: 'anthropic', key: KEY, label: 'My Claude' });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.connected.last4).toBe(KEY.slice(-4));
    // The response must never carry the key back.
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('REFUSES to store a key that does not verify — no false "connected"', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, neverLive));
    const res = await request(app).post('/api/fuel').send({ provider: 'anthropic', key: KEY });
    expect(res.status).toBe(422);
    expect(res.body.verified).toBe(false);
    // And nothing was written — a customer with a bad key is not silently
    // "connected" and then silently downgraded.
    expect(await listConnected(db, orgId)).toHaveLength(0);
  });

  it('lists connected fuel display-only, and names what is coming', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    await request(app).post('/api/fuel').send({ provider: 'anthropic', key: KEY });

    const res = await request(app).get('/api/fuel');
    expect(res.status).toBe(200);
    expect(res.body.connected).toHaveLength(1);
    expect(res.body.connected[0].provider).toBe('anthropic');
    expect(res.body.available).toContain('anthropic');
    expect(res.body.coming_soon).toContain('gemini');
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('turns away a not-yet-supported provider honestly', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    const res = await request(app).post('/api/fuel').send({ provider: 'gemini', key: 'gm-some-key' });
    expect(res.status).toBe(400);
    expect(res.body.coming_soon).toBe(true);
    expect(await listConnected(db, orgId)).toHaveLength(0);
  });

  it('revokes a connected key', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    await request(app).post('/api/fuel').send({ provider: 'anthropic', key: KEY });
    const res = await request(app).delete('/api/fuel/anthropic');
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(await listConnected(db, orgId)).toHaveLength(0);
  });

  it('validates the request body', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    expect((await request(app).post('/api/fuel').send({ provider: 'anthropic' })).status).toBe(400);
    expect((await request(app).post('/api/fuel').send({ provider: 'nope', key: KEY })).status).toBe(400);
    expect((await request(app).post('/api/fuel').send({ provider: 'anthropic', key: 'short' })).status).toBe(400);
  });
});
