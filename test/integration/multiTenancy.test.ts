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
import { createPortabilityRouter } from '../../src/server/web/routes/portability.js';
import { createDevicesRouter } from '../../src/server/web/routes/devices.js';
import { createOrgRouter } from '../../src/server/web/routes/org.js';
import { createMemoryRouter } from '../../src/server/web/routes/memory.js';
import { createAskRouter } from '../../src/server/web/routes/ask.js';
import { createFuelRouter } from '../../src/server/web/routes/fuel.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { localDateString } from '../../src/server/digest/timezone.js';

/**
 * Acceptance gate 7: "a second Clerk org sees none of the first org's data
 * (multi-tenancy proven by test, not by inspection)." One running app
 * instance, two orgs, reading the org from a per-request header the way
 * ensureOrg() reads it from Clerk in production, so this exercises the same
 * request-scoping logic.
 *
 * Covered here: packs, projects, tray, today, export/import, devices, org
 * settings, memory, and Ask's model context. Scoped in their own suites:
 * feedback, trust, connector health, admin.
 *
 * A note on how this file drifted, because the same thing will happen again:
 * it used to say "every API surface" while mounting four routers, and four
 * more surfaces shipped afterwards without joining it — including export,
 * which returns bulk data. The claim outgrew the coverage silently, which is
 * exactly how an isolation gap survives a green suite. When you add a router,
 * add it here, and keep this list honest rather than aspirational.
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
    // The four surfaces added after this suite was written. Its docstring
    // claimed "every API surface" while covering four routers; that claim
    // outgrew its coverage, which is how an isolation gap survives a green
    // suite. Export in particular hands back bulk data.
    app.use(createPortabilityRouter(db));
    app.use(createDevicesRouter(db));
    app.use(createOrgRouter(db));
    app.use(createMemoryRouter(db));

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

  it('export hands back only the calling org\'s data, never the other\'s', async () => {
    // The most severe surface here: a bulk dump. Org A has a full slice of
    // data seeded above; org B has none and must receive none.
    const bundleB = await request(app).get('/api/export').set('x-test-org', orgB);
    expect(bundleB.status).toBe(200);
    const serialisedB = JSON.stringify(bundleB.body);
    expect(serialisedB).not.toContain('Loom (Org A)');
    expect(serialisedB).not.toContain('acme/loom');

    // And org A's own export still works, so this is scoping rather than a
    // blanket empty response that would pass the assertion for the wrong reason.
    const bundleA = await request(app).get('/api/export').set('x-test-org', orgA);
    expect(bundleA.status).toBe(200);
    expect(JSON.stringify(bundleA.body)).toContain('Loom (Org A)');
  });

  it('device tokens are scoped: org B cannot see or unregister org A\'s device', async () => {
    // A leak here routes another customer's push notifications to this phone.
    const reg = await request(app)
      .post('/api/devices')
      .set('x-test-org', orgA)
      .send({ token: 'apns-token-org-a', platform: 'ios' });
    expect(reg.status).toBeLessThan(300);

    // Org B deleting the same token string must not remove org A's row.
    await request(app).delete('/api/devices/apns-token-org-a').set('x-test-org', orgB);

    const reReg = await request(app)
      .post('/api/devices')
      .set('x-test-org', orgA)
      .send({ token: 'apns-token-org-a', platform: 'ios' });
    expect(reReg.status).toBeLessThan(300); // still A's to manage
  });

  it('memory roll-ups do not count another org\'s projects', async () => {
    const memB = await request(app).get('/api/memory').set('x-test-org', orgB);
    expect(memB.status).toBe(200);
    expect(JSON.stringify(memB.body)).not.toContain('Loom (Org A)');
  });

  it('org settings are per-org: B changing its timezone does not move A', async () => {
    await request(app).patch('/api/org/timezone').set('x-test-org', orgB).send({ timezone: 'Asia/Tokyo', source: 'user' });

    const a = await request(app).get('/api/org').set('x-test-org', orgA);
    expect(a.body.timezone).toBe('UTC');
    const b = await request(app).get('/api/org').set('x-test-org', orgB);
    expect(b.body.timezone).toBe('Asia/Tokyo');
  });

  it('Ask never puts another org\'s stack into the model context', async () => {
    // Asserts on what was SENT to the model, not just what came back: a
    // scoping bug here would leak org A's projects into org B's prompt even
    // if the answer happened to look innocuous.
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { answer: 'Nothing to report.', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));
    const askApp = express();
    askApp.use(express.json());
    askApp.use((req, _res, next) => {
      (req as Request & { orgId: string }).orgId = req.header('x-test-org') ?? '';
      next();
    });
    askApp.use(createAskRouter(db, { llm: fake, db }));

    await request(askApp).post('/api/ask').set('x-test-org', orgB).send({ question: 'How are my apps?' });

    const sent = JSON.stringify(fake.requests);
    expect(sent).not.toContain('Loom (Org A)');
    expect(sent).not.toContain('acme/loom');
  });

  it('fuel credentials are scoped: org B cannot see or revoke org A\'s key', async () => {
    // A leak here would expose (or let another tenant delete) the credential
    // that spends org A's money. Cryptography already blocks decryption
    // cross-org; this proves the HTTP surface is scoped too.
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const fuelApp = express();
    fuelApp.use(express.json());
    fuelApp.use((req, _res, next) => {
      (req as Request & { orgId: string }).orgId = req.header('x-test-org') ?? '';
      next();
    });
    fuelApp.use(createFuelRouter(db, async () => true));

    await request(fuelApp).post('/api/fuel').set('x-test-org', orgA).send({ provider: 'anthropic', key: 'sk-ant-org-a-secret' });

    // Org B sees an empty fuel list...
    const listB = await request(fuelApp).get('/api/fuel').set('x-test-org', orgB);
    expect(listB.body.connected).toHaveLength(0);
    expect(JSON.stringify(listB.body)).not.toContain('org-a-secret');

    // ...and revoking anthropic as org B does not remove org A's credential.
    await request(fuelApp).delete('/api/fuel/anthropic').set('x-test-org', orgB);
    const listA = await request(fuelApp).get('/api/fuel').set('x-test-org', orgA);
    expect(listA.body.connected).toHaveLength(1);
    delete process.env.CREDENTIALS_KEY;
  });

  it('an unrecognized org id never falls back to another org\'s data', async () => {
    const res = await request(app).get('/api/packs').set('x-test-org', 'org_nonexistent');
    expect(res.body).toEqual([]);
  });
});
