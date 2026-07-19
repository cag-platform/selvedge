import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { createPacksRouter } from '../../src/server/web/routes/packs.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/packs', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_a' }, { orgId: 'org_b' }]);
  });
  afterEach(async () => close());

  it('lists only the requesting org\'s packs', async () => {
    await createPack(db, 'org_a', makeTestPack({ identity: { project_id: 'p1', name: 'P1', owner_description: 'x' } }));
    await createPack(db, 'org_b', makeTestPack({ identity: { project_id: 'p2', name: 'P2', owner_description: 'x' } }));

    const app = appWithOrg('org_a', createPacksRouter(db));
    const res = await request(app).get('/api/packs');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].identity.project_id).toBe('p1');
  });

  it('404s for a pack in another org', async () => {
    await createPack(db, 'org_b', makeTestPack({ identity: { project_id: 'p2', name: 'P2', owner_description: 'x' } }));
    const app = appWithOrg('org_a', createPacksRouter(db));
    const res = await request(app).get('/api/packs/p2');
    expect(res.status).toBe(404);
  });

  it('PATCH updates human-owned sections and rejects an invalid patch with 422', async () => {
    await createPack(db, 'org_a', makeTestPack({ identity: { project_id: 'p1', name: 'P1', owner_description: 'x' } }));
    const app = appWithOrg('org_a', createPacksRouter(db));

    const ok = await request(app).patch('/api/packs/p1').send({ identity: { name: 'Renamed' } });
    expect(ok.status).toBe(200);
    expect(ok.body.identity.name).toBe('Renamed');

    const bad = await request(app).patch('/api/packs/p1').send({ voice: { detail_level: 'nonsense' } });
    expect(bad.status).toBe(422);
  });
});
