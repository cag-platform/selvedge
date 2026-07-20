import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, trustIncidents } from '../../src/server/db/schema/index.js';
import { createTrustRouter } from '../../src/server/web/routes/trust.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/trust', () => {
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

  it('reports a plain track record', async () => {
    await db.insert(narrations).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      eventId: ulid(),
      eventType: 'runtime.recovered',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      verdict: 'users_fine',
      confidence: 'high',
    });

    const app = appWithOrg(orgId, createTrustRouter(db));
    const res = await request(app).get('/api/trust/track-record');
    expect(res.status).toBe(200);
    expect(res.body.narrated).toBe(1);
    expect(res.body.verdicts.users_fine).toBe(1);
    expect(typeof res.body.summary).toBe('string');
  });

  it('lists Class-1 incidents scoped to the org', async () => {
    await db.insert(trustIncidents).values({ id: ulid(), orgId, projectId: 'loom', kind: 'false_all_clear', detail: 'said fine, wasnt' });
    await db.insert(orgs).values({ orgId: 'org_2' });
    await db.insert(trustIncidents).values({ id: ulid(), orgId: 'org_2', projectId: 'x', kind: 'false_all_clear' });

    const app = appWithOrg(orgId, createTrustRouter(db));
    const res = await request(app).get('/api/trust/incidents');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].kind).toBe('false_all_clear');
  });
});
