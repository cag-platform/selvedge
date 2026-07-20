import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { createProjectsRouter } from '../../src/server/web/routes/projects.js';
import { createTrayRouter } from '../../src/server/web/routes/tray.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/projects', () => {
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

  it('returns pack cards with a plain health line', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'yoke', name: 'YOKE', owner_description: 'x' },
        topology: {
          sources: [{ connector: 'github', resource_id: 'a/yoke', role: 'source_of_truth' }],
          capability_gaps: [{ gap: 'checkout', summary: "day 12 of visitors being unable to buy" }],
        },
      }),
    );

    const app = appWithOrg(orgId, createProjectsRouter(db));
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('YOKE');
    expect(res.body[0].health_line).toContain('day 12');
  });
});

describe('web/routes/tray', () => {
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

  it('lists unsorted events and assigns them via POST /api/tray/assign', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' }, topology: { sources: [] } }));
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd1',
    });

    const app = appWithOrg(orgId, createTrayRouter(db));
    const listed = await request(app).get('/api/tray');
    expect(listed.body).toHaveLength(1);

    const assigned = await request(app)
      .post('/api/tray/assign')
      .send({ connector: 'github', resource_id: 'acme/loom', project_id: 'loom' });
    expect(assigned.status).toBe(200);
    expect(assigned.body.updatedCount).toBe(1);

    const afterAssign = await request(app).get('/api/tray');
    expect(afterAssign.body).toHaveLength(0);
  });

  it('400s when a required field is missing', async () => {
    const app = appWithOrg(orgId, createTrayRouter(db));
    const res = await request(app).post('/api/tray/assign').send({ connector: 'github' });
    expect(res.status).toBe(400);
  });
});
