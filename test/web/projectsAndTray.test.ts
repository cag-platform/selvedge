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
    expect(res.body[0].review_ready).toBe(false);
    expect(res.body[0].online).toBe(false);
  });

  /**
   * MAKE THE DATABASE THEIRS — the claim mints Neon's transfer request and
   * hands back the claim URL; the accept is the owner's browser's job. What
   * must hold here: org scoping, a project without a provisioned database
   * refuses plainly, Neon's failures arrive as sentences, and the URL is the
   * documented console format with the pieces encoded.
   */
  it('mints a claim link for a provisioned database', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        topology: { sources: [{ connector: 'neon', resource_id: 'shiny-water-123', role: 'database' }] },
      }),
    );
    const app = appWithOrg(
      orgId,
      createProjectsRouter(db, { createTransfer: async () => ({ id: 'tr_9', expiresAt: '2026-09-01T00:00:00Z' }) }),
    );
    const res = await request(app).post('/api/projects/loom/database/claim');
    expect(res.status).toBe(200);
    expect(res.body.claim_url).toBe('https://console.neon.tech/app/claim?p=shiny-water-123&tr=tr_9');
    expect(res.body.expires_at).toBe('2026-09-01T00:00:00Z');
  });

  it('a project with no provisioned database refuses plainly', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'bare', name: 'Bare', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'a/bare', role: 'source_of_truth' }] },
      }),
    );
    const app = appWithOrg(orgId, createProjectsRouter(db, { createTransfer: async () => ({ id: 'x', expiresAt: 'y' }) }));
    const res = await request(app).post('/api/projects/bare/database/claim');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no Selvedge-provisioned database');
  });

  it("never claims across orgs — another org's project is not found", async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    await createPack(
      db,
      'org_2',
      makeTestPack({
        identity: { project_id: 'theirs', name: 'Theirs', owner_description: 'x' },
        topology: { sources: [{ connector: 'neon', resource_id: 'their-db', role: 'database' }] },
      }),
    );
    const app = appWithOrg(orgId, createProjectsRouter(db, { createTransfer: async () => ({ id: 'x', expiresAt: 'y' }) }));
    expect((await request(app).post('/api/projects/theirs/database/claim')).status).toBe(404);
  });

  /**
   * The doors to the accounts behind a project ride the card payload, built
   * server-side so both clients render the same strings. The URL formats
   * themselves are pinned in test/connectors/consoles.test.ts — this holds
   * that they actually reach a client.
   */
  it('carries the console doors on the card', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        topology: {
          sources: [
            { connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' },
            { connector: 'railway', resource_id: 'p1/e1/s1', role: 'production_host' },
            { connector: 'neon', resource_id: 'db-7', role: 'database' },
          ],
        },
      }),
    );

    const app = appWithOrg(orgId, createProjectsRouter(db));
    const res = await request(app).get('/api/projects');
    expect(res.body[0].console_links).toEqual([
      { provider: 'Railway', label: 'variables & deploys', url: 'https://railway.com/project/p1/service/s1/variables?environmentId=e1' },
      { provider: 'Neon', label: 'database console', url: 'https://console.neon.tech/app/projects/db-7' },
      { provider: 'GitHub', label: 'acme/loom', url: 'https://github.com/acme/loom' },
    ]);
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
