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

  it('an unconfigured vault is a plain 503 sentence, never an "internal error"', async () => {
    // The exact production bug: CREDENTIALS_KEY missing → the vault throws →
    // the owner saw a bare 500. Now it says what's wrong and what to set.
    delete process.env.CREDENTIALS_KEY;
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    const res = await request(app).post('/api/fuel').send({ provider: 'anthropic', key: KEY });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/CREDENTIALS_KEY/);
    expect(res.body.error).toMatch(/nothing was saved/i);
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
    expect(res.body.available).toContain('kimi');
    // Nothing is "coming soon" any more — every declared provider is wired.
    // The field stays because the honest thing to do with a future
    // declared-but-unwired row is still to name it rather than hide it.
    expect(res.body.coming_soon).toEqual([]);
    // And each one is named the way a person would name it, from the same
    // table the call itself reads.
    expect(res.body.labels.kimi).toMatch(/Kimi/);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('takes a key for every provider it declares', async () => {
    // The inverse of the test this replaces. Gemini used to be turned away as
    // not-yet-supported; the whole point of the provider table is that there
    // is no longer a declared provider the connect screen has to refuse.
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    for (const provider of ['gemini', 'kimi', 'xai', 'deepseek', 'mistral']) {
      const res = await request(app).post('/api/fuel').send({ provider, key: `key-for-${provider}` });
      // 200 rather than 201: connecting is an upsert, so it is not always a
      // creation. What matters is that it is accepted.
      expect([200, 201], provider).toContain(res.status);
    }
    expect(await listConnected(db, orgId)).toHaveLength(5);
  });

  it('still turns away a provider it has never heard of', async () => {
    const app = appWithOrg(orgId, createFuelRouter(db, alwaysLive));
    const res = await request(app).post('/api/fuel').send({ provider: 'not-a-provider', key: 'k' });
    expect(res.status).toBe(400);
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
