import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, events } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { createPacksRouter } from '../../src/server/web/routes/packs.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { onPlan } from '../helpers/plan.js';
import { planLimits } from '../../src/shared/plans.js';

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

  it('POST with create_repo mints the repo first and maps the project to it', async () => {
    const created: string[] = [];
    const app = appWithOrg(
      'org_a',
      createPacksRouter(db, {
        createRepo: async (name) => {
          created.push(name);
          return { fullName: `cag-platform/${name}` };
        },
      }),
    );
    const res = await request(app).post('/api/packs').send({ name: 'Fresh Idea', create_repo: true, tier: 'sandbox' });
    expect(res.status).toBe(201);
    expect(created).toEqual(['fresh-idea']);
    expect(res.body.topology.sources[0].resource_id).toBe('cag-platform/fresh-idea');
    expect(res.body.identity.links.repo_url).toBe('https://github.com/cag-platform/fresh-idea');
  });

  it('POST with create_repo surfaces GitHub failures plainly and creates no pack', async () => {
    const { GithubError } = await import('../../src/server/connectors/github/newRepo.js');
    const app = appWithOrg(
      'org_a',
      createPacksRouter(db, {
        createRepo: async (name) => {
          throw new GithubError(`a repo named "${name}" already exists in cag-platform`, true);
        },
      }),
    );
    const res = await request(app).post('/api/packs').send({ name: 'Taken', create_repo: true, tier: 'sandbox' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
    expect(res.body.error).toMatch(/Nothing was created/);
    expect((await request(app).get('/api/packs')).body).toHaveLength(0);
  });

  it('POST with create_repo is a clear 503 when the engine token is not configured', async () => {
    const app = appWithOrg('org_a', createPacksRouter(db)); // no createRepo dep
    const res = await request(app).post('/api/packs').send({ name: 'No Engine', create_repo: true, tier: 'sandbox' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/GITHUB_TOKEN/);
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

  it('DELETE removes the project and its scoped data, and 404s on a repeat', async () => {
    await createPack(db, 'org_a', makeTestPack({ identity: { project_id: 'p1', name: 'P1', owner_description: 'x' } }));
    await ingestEvent(db, {
      org_id: 'org_a',
      source: 'github',
      source_account_id: 'acme/test-project',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd1',
    });
    const app = appWithOrg('org_a', createPacksRouter(db));

    // The event resolved to p1 (its source is p1's repo).
    const beforeEvents = await db.select().from(events).where(eq(events.projectId, 'p1'));
    expect(beforeEvents.length).toBeGreaterThan(0);

    const del = await request(app).delete('/api/packs/p1');
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    expect((await request(app).get('/api/packs/p1')).status).toBe(404);
    expect((await db.select().from(events).where(eq(events.projectId, 'p1')))).toHaveLength(0);

    // Deleting again is a clean 404, not a 500.
    expect((await request(app).delete('/api/packs/p1')).status).toBe(404);
  });

  it("DELETE won't reach across orgs", async () => {
    await createPack(db, 'org_b', makeTestPack({ identity: { project_id: 'p2', name: 'P2', owner_description: 'x' } }));
    const app = appWithOrg('org_a', createPacksRouter(db));
    expect((await request(app).delete('/api/packs/p2')).status).toBe(404);
    // org_b's pack is untouched.
    const appB = appWithOrg('org_b', createPacksRouter(db));
    expect((await request(appB).get('/api/packs/p2')).status).toBe(200);
  });

  /**
   * THE PROJECT LIMIT.
   *
   * The property worth holding is not the number — it is that the refusal
   * arrives BEFORE anything is made. This route can create a real GitHub repo
   * on the way to creating a project; a limit that bit afterwards would leave
   * the owner with a repo they never got to use.
   */
  describe('how many projects a plan allows', () => {
    const app = () => appWithOrg('org_a', createPacksRouter(db));
    const newProject = (name: string) => request(app()).post('/api/packs').send({ name, repo: `acme/${name}`, tier: 'sandbox' });

    const fill = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await createPack(db, 'org_a', makeTestPack({ identity: { project_id: `p${i}`, name: `P${i}`, owner_description: 'x' } }));
      }
    };

    it('refuses the one past the limit, with a code and a price', async () => {
      await fill(planLimits('free').projects!);
      const res = await newProject('third');

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('limit_projects');
      expect(res.body.error).toMatch(/\$12\/month/);
      expect(res.body.limit).toBe(planLimits('free').projects);
    });

    /** A repo is a side effect on somebody else's server. It must not happen and then be refused. */
    it('refuses before it creates a repo', async () => {
      await fill(planLimits('free').projects!);
      let made = false;
      const router = createPacksRouter(db, {
        createRepo: async (name: string) => {
          made = true;
          return { fullName: `acme/${name}` };
        },
      });
      const res = await request(appWithOrg('org_a', router)).post('/api/packs').send({ name: 'third', create_repo: true, tier: 'sandbox' });

      expect(res.status).toBe(402);
      expect(made).toBe(false);
    });

    it('lets a paying account keep going', async () => {
      await fill(5);
      await onPlan(db, 'org_a');
      expect((await newProject('sixth')).status).toBe(201);
    });

    /**
     * A downgrade restricts, it never deletes. Five projects stay five
     * projects; what stops is making a sixth.
     */
    it('leaves the projects an over-limit account already has', async () => {
      await fill(5);
      expect((await newProject('sixth')).status).toBe(402);
      expect((await request(app()).get('/api/packs')).body).toHaveLength(5);
      expect((await request(app()).get('/api/packs/p0')).status).toBe(200);
    });
  });
});
