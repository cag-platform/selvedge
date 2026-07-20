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

  it('POST creates a valid pack from the New Project form and triggers a backfill', async () => {
    const backfilled: Array<{ orgId: string; repo: string }> = [];
    const app = appWithOrg(
      'org_a',
      createPacksRouter(db, { backfill: async (orgId, repo) => void backfilled.push({ orgId, repo }) }),
    );

    const res = await request(app).post('/api/packs').send({
      name: 'Loom Orders',
      repo: 'acme/loom',
      tier: 'live_critical',
      touches_money: true,
      downtime_translation: "retailers can't submit orders",
    });
    expect(res.status).toBe(201);
    expect(res.body.identity.project_id).toBe('loom-orders');
    expect(res.body.stakes.has_external_users).toBe(true);
    expect(res.body.topology.sources[0]).toEqual({ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' });

    // Pack is validated and listed; backfill was fired for the mapped repo.
    const list = await request(app).get('/api/packs');
    expect(list.body).toHaveLength(1);
    await new Promise((r) => setImmediate(r));
    expect(backfilled).toEqual([{ orgId: 'org_a', repo: 'acme/loom' }]);
  });

  it('POST rejects bad input and duplicate project ids', async () => {
    const app = appWithOrg('org_a', createPacksRouter(db));

    expect((await request(app).post('/api/packs').send({ name: 'X', repo: 'not-a-full-name', tier: 'live_small' })).status).toBe(400);
    expect((await request(app).post('/api/packs').send({ name: 'X', repo: 'a/b', tier: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/packs').send({ name: '', repo: 'a/b', tier: 'personal' })).status).toBe(400);

    expect((await request(app).post('/api/packs').send({ name: 'Same Name', repo: 'a/b', tier: 'personal' })).status).toBe(201);
    expect((await request(app).post('/api/packs').send({ name: 'Same Name', repo: 'a/c', tier: 'personal' })).status).toBe(409);
  });

  it('POST scopes the created pack to the requesting org', async () => {
    const appA = appWithOrg('org_a', createPacksRouter(db));
    const appB = appWithOrg('org_b', createPacksRouter(db));
    await request(appA).post('/api/packs').send({ name: 'Mine', repo: 'a/b', tier: 'personal' });
    expect((await request(appB).get('/api/packs')).body).toEqual([]);
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
