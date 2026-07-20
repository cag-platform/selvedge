import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, devices } from '../../src/server/db/schema/index.js';
import { createDevicesRouter } from '../../src/server/web/routes/devices.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/devices', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('registers a device token', async () => {
    const app = appWithOrg(orgId, createDevicesRouter(db));
    const res = await request(app).post('/api/devices').send({ token: 'abc123', platform: 'ios', environment: 'sandbox' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const rows = await db.select().from(devices).where(eq(devices.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe('abc123');
    expect(rows[0]!.environment).toBe('sandbox');
  });

  it('is idempotent — re-registering the same token upserts, not duplicates', async () => {
    const app = appWithOrg(orgId, createDevicesRouter(db));
    await request(app).post('/api/devices').send({ token: 'abc123', platform: 'ios' });
    await request(app).post('/api/devices').send({ token: 'abc123', platform: 'ios', environment: 'production' });

    const rows = await db.select().from(devices).where(eq(devices.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.environment).toBe('production');
  });

  it('defaults environment to production', async () => {
    const app = appWithOrg(orgId, createDevicesRouter(db));
    await request(app).post('/api/devices').send({ token: 'tok', platform: 'ios' });
    const [row] = await db.select().from(devices).where(eq(devices.orgId, orgId));
    expect(row!.environment).toBe('production');
  });

  it('400s on a missing token or bad platform', async () => {
    const app = appWithOrg(orgId, createDevicesRouter(db));
    expect((await request(app).post('/api/devices').send({ platform: 'ios' })).status).toBe(400);
    expect((await request(app).post('/api/devices').send({ token: 't', platform: 'blackberry' })).status).toBe(400);
    expect((await request(app).post('/api/devices').send({ token: 't', platform: 'ios', environment: 'nope' })).status).toBe(400);
  });

  it('unregisters a device token', async () => {
    const app = appWithOrg(orgId, createDevicesRouter(db));
    await request(app).post('/api/devices').send({ token: 'gone', platform: 'ios' });
    const del = await request(app).delete('/api/devices/gone');
    expect(del.status).toBe(200);
    const rows = await db.select().from(devices).where(eq(devices.orgId, orgId));
    expect(rows).toHaveLength(0);
  });
});
