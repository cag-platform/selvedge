import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, narrationLibrary } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { createMemoryRouter } from '../../src/server/web/routes/memory.js';
import { createPortabilityRouter } from '../../src/server/web/routes/portability.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/memory', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'orders' } }));
  });
  afterEach(async () => close());

  it('serves the stack roll-up and a per-project memory', async () => {
    await db.insert(narrationLibrary).values({ id: ulid(), fingerprint: 'fp1', phrasing: { fragment: '{project} flaky check' }, status: 'graduated' });
    await db.insert(narrations).values({
      id: ulid(), orgId, projectId: 'loom', eventId: ulid(), eventType: 'build.failed',
      occurredAt: new Date(), path: 'LIB', intendedPath: 'LIB', delivery: 'DIGEST', meta: { fingerprint: 'fp1' },
    });

    const app = appWithOrg(orgId, createMemoryRouter(db));

    const stack = await request(app).get('/api/memory');
    expect(stack.status).toBe(200);
    expect(stack.body.apps).toBe(1);
    expect(typeof stack.body.summary).toBe('string');

    const project = await request(app).get('/api/projects/loom/memory');
    expect(project.status).toBe(200);
    expect(project.body.learned_signatures[0].plain).toBe('Loom flaky check');

    const missing = await request(app).get('/api/projects/nope/memory');
    expect(missing.status).toBe(404);
  });
});

describe('web/routes/portability', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'orders' } }));
  });
  afterEach(async () => close());

  it('exports a bundle that re-imports into another org (round-trip)', async () => {
    const exportApp = appWithOrg(orgId, createPortabilityRouter(db));
    const exported = await request(exportApp).get('/api/export');
    expect(exported.status).toBe(200);
    expect(exported.body.selvedge_export_version).toBe('1');
    expect(exported.body.packs).toHaveLength(1);

    // Import into a fresh org — the pack is restored there.
    await db.insert(orgs).values({ orgId: 'org_2' });
    const importApp = appWithOrg('org_2', createPortabilityRouter(db));
    const imported = await request(importApp).post('/api/import').send(exported.body);
    expect(imported.status).toBe(200);
    expect(imported.body.restored).toBe(1);

    expect(await getPack(db, 'org_2', 'loom')).not.toBeNull();
  });

  it('400s on a body that is not a bundle', async () => {
    const app = appWithOrg(orgId, createPortabilityRouter(db));
    expect((await request(app).post('/api/import').send({ nope: true })).status).toBe(400);
  });
});
