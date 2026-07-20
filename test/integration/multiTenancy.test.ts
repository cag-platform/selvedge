import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { composeDigestForOrg } from '../../src/server/digest/compose.js';
import { createPacksRouter } from '../../src/server/web/routes/packs.js';
import { createProjectsRouter } from '../../src/server/web/routes/projects.js';
import { createTrayRouter } from '../../src/server/web/routes/tray.js';
import { createTodayRouter } from '../../src/server/web/routes/today.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { localDateString } from '../../src/server/digest/timezone.js';

/**
 * Acceptance gate 7: "a second Clerk org sees none of the first org's
 * data (multi-tenancy proven by test, not by inspection)." One running
 * app instance, two orgs, every API surface — reading the org from a
 * per-request header the way ensureOrg() reads it from Clerk in
 * production, so this exercises the same request-scoping logic.
 */
describe('multi-tenancy: org isolation across every API surface', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let app: express.Express;
  const orgA = 'org_a';
  const orgB = 'org_b';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([
      { orgId: orgA, timezone: 'UTC' },
      { orgId: orgB, timezone: 'UTC' },
    ]);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Stands in for ensureOrg()/getAuth() — the org comes from a
      // per-request header instead of a Clerk session, isolating the
      // multi-tenancy scoping logic itself from Clerk's own mechanics.
      (req as Request & { orgId: string }).orgId = req.header('x-test-org') ?? '';
      next();
    });
    app.use(createPacksRouter(db));
    app.use(createProjectsRouter(db));
    app.use(createTrayRouter(db));
    app.use(createTodayRouter(db));

    // Seed org A with a full slice of data: a pack, an ingested event, a tray item, a digest.
    await createPack(
      db,
      orgA,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom (Org A)', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    // Clock-relative: /api/today reads the real clock, so the digest must
    // be composed for the real "today" (24h ago always falls in yesterday).
    const now = new Date();
    await ingestEvent(db, {
      org_id: orgA,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'build.failed',
      occurred_at: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      severity_hint: 'error',
      raw: {},
      dedupe_key: 'orgA-1',
    });
    await ingestEvent(db, {
      org_id: orgA,
      source: 'github',
      source_account_id: 'acme/unmapped',
      event_type: 'code.pr_opened',
      occurred_at: now.toISOString(),
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'orgA-2',
    });
    await composeDigestForOrg(db, orgA, now);
  });

  afterEach(async () => close());

  it('org B sees an empty world even though org A is fully populated', async () => {
    const asOrgB = (path: string) => request(app).get(path).set('x-test-org', orgB);

    const packs = await asOrgB('/api/packs');
    expect(packs.body).toEqual([]);

    const projects = await asOrgB('/api/projects');
    expect(projects.body).toEqual([]);

    const tray = await asOrgB('/api/tray');
    expect(tray.body).toEqual([]);

    const today = await asOrgB('/api/today');
    expect(today.body.digest).toBeNull();
    expect(today.body.post_digest_events).toEqual([]);
  });

  it('org B cannot reach org A\'s pack by id, or patch it', async () => {
    const get = await request(app).get('/api/packs/loom').set('x-test-org', orgB);
    expect(get.status).toBe(404);

    const patch = await request(app).patch('/api/packs/loom').set('x-test-org', orgB).send({ identity: { name: 'Hijacked' } });
    expect(patch.status).toBe(404);

    // Org A's pack is untouched.
    const stillOrgAs = await request(app).get('/api/packs/loom').set('x-test-org', orgA);
    expect(stillOrgAs.body.identity.name).toBe('Loom (Org A)');
  });

  it('org B assigning a tray item cannot touch org A\'s unsorted event or pack', async () => {
    // Org B has no pack "loom" — assignment should be a no-op against org A's data.
    await request(app)
      .post('/api/tray/assign')
      .set('x-test-org', orgB)
      .send({ connector: 'github', resource_id: 'acme/unmapped', project_id: 'loom' })
      .expect(404); // no pack "loom" exists for org B: updateMachineSections throws "No pack..."

    const orgATray = await request(app).get('/api/tray').set('x-test-org', orgA);
    expect(orgATray.body).toHaveLength(1); // still unresolved, org A's event untouched
  });

  it('org A still sees its own data throughout', async () => {
    const asOrgA = (path: string) => request(app).get(path).set('x-test-org', orgA);

    expect((await asOrgA('/api/packs')).body).toHaveLength(1);
    expect((await asOrgA('/api/projects')).body).toHaveLength(1);
    expect((await asOrgA('/api/tray')).body).toHaveLength(1);
    expect((await asOrgA('/api/today')).body.digest?.digestDate).toBe(localDateString(new Date(), 'UTC'));
  });

  it('an unrecognized org id never falls back to another org\'s data', async () => {
    const res = await request(app).get('/api/packs').set('x-test-org', 'org_nonexistent');
    expect(res.body).toEqual([]);
  });
});
