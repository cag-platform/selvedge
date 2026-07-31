import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, connectorHealth } from '../../src/server/db/schema/index.js';
import { createConnectorsHealthRouter } from '../../src/server/web/routes/connectorsHealth.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/connectors/health', () => {
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

  it('returns the org connector health rows in snake_case', async () => {
    await db.insert(connectorHealth).values({
      orgId,
      connector: 'github',
      sourceAccountId: 'inst_42',
      status: 'auth_failed',
      meta: 'acme',
    });

    const app = appWithOrg(orgId, createConnectorsHealthRouter(db));
    const res = await request(app).get('/api/connectors/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      connector: 'github',
      source_account_id: 'inst_42',
      status: 'auth_failed',
      note: 'acme',
    });
  });

  it('scopes rows to the requesting org', async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    await db.insert(connectorHealth).values({ orgId: 'org_2', connector: 'github', sourceAccountId: 'other', status: 'fresh' });

    const app = appWithOrg(orgId, createConnectorsHealthRouter(db));
    const res = await request(app).get('/api/connectors/health');
    expect(res.body).toHaveLength(0);
  });
});
