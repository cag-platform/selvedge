import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { createTrayRouter } from '../../src/server/web/routes/tray.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

/**
 * THE UNSORTED TRAY, WITH THREE ANSWERS.
 *
 * It offered exactly one — "this belongs to an existing project" — against an
 * opaque id. For GitHub, that id IS the repository's full name, so the tray
 * already held the answer to "which repo is this?" and never said so; and the
 * most likely true answer for a repo you own ("that's a project I haven't set
 * up yet") had no button at all. Anything in that case, or in the "not mine to
 * care about" case, sat there forever, and a tray that only grows stops being
 * read.
 */
describe('the unsorted tray — where does this belong?', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  let backfilled: string[];

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    backfilled = [];
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  const app = () =>
    appWithOrg(
      orgId,
      createTrayRouter(db, {
        backfill: async (_org, repo) => {
          backfilled.push(repo);
        },
      }),
    );

  async function arrive(repo: string, key: string) {
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: repo,
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: key,
    });
  }

  /** The user's own complaint: it doesn't let me pick the GitHub repo. */
  it('says which repo each row is, rather than showing an opaque id', async () => {
    await arrive('cag-platform/selvedge', 'd1');
    await arrive('cag-platform/selvedge', 'd2');

    const res = await request(app()).get('/api/tray/sources').expect(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      connector: 'github',
      resource_id: 'cag-platform/selvedge',
      label: 'cag-platform/selvedge',
      is_repo: true,
      count: 2,
    });
  });

  it('groups by source, so one answer settles everything from it', async () => {
    await arrive('cag-platform/selvedge', 'd1');
    await arrive('cag-platform/selvedge-mobile', 'd2');
    await arrive('cag-platform/selvedge-mobile', 'd3');

    const res = await request(app()).get('/api/tray/sources').expect(200);
    expect(res.body.sources.map((s: { resource_id: string; count: number }) => [s.resource_id, s.count]).sort()).toEqual([
      ['cag-platform/selvedge', 1],
      ['cag-platform/selvedge-mobile', 2],
    ]);
  });

  /** WATCH IT — the answer that did not exist. */
  it('turns a repo into a project, named after the repo, with its events on it', async () => {
    await arrive('cag-platform/selvedge', 'd1');

    const res = await request(app())
      .post('/api/tray/watch')
      .send({ connector: 'github', resource_id: 'cag-platform/selvedge' })
      .expect(201);

    expect(res.body.name).toBe('selvedge');
    expect(res.body.updated_count).toBe(1);

    const pack = await getPack(db, orgId, res.body.project_id);
    expect(pack!.topology.sources).toContainEqual({
      connector: 'github',
      resource_id: 'cag-platform/selvedge',
      role: 'source_of_truth',
    });
    // Born with history, not empty.
    expect(backfilled).toEqual(['cag-platform/selvedge']);
    // And it never asks again.
    expect((await request(app()).get('/api/tray/sources')).body.sources).toHaveLength(0);
  });

  it('starts a watched project at the gentlest stakes rather than guessing', async () => {
    await arrive('cag-platform/selvedge', 'd1');
    const res = await request(app()).post('/api/tray/watch').send({ connector: 'github', resource_id: 'cag-platform/selvedge' });

    const pack = await getPack(db, orgId, res.body.project_id);
    expect(pack!.stakes.tier).toBe('personal');
    expect(pack!.stakes.touches_money).toBe(false);
  });

  it('does not collide with a project that already has the name', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'selvedge', name: 'Selvedge', owner_description: 'x' }, topology: { sources: [] } }));
    await arrive('cag-platform/selvedge', 'd1');

    const res = await request(app()).post('/api/tray/watch').send({ connector: 'github', resource_id: 'cag-platform/selvedge' }).expect(201);
    expect(res.body.project_id).not.toBe('selvedge');
    expect(await getPack(db, orgId, 'selvedge')).not.toBeNull();
  });

  it('will not invent a project from something that is not a repo', async () => {
    await arrive('some-account', 'd1');
    const res = await request(app()).post('/api/tray/watch').send({ connector: 'sentry', resource_id: 'some-account' }).expect(422);
    expect(res.body.error).toMatch(/repository/i);
  });

  /** IGNORE — the third honest answer. */
  it('stops asking about a source the owner dismissed', async () => {
    await arrive('someone-else/thing', 'd1');
    await request(app()).post('/api/tray/ignore').send({ connector: 'github', resource_id: 'someone-else/thing' }).expect(200);

    const res = await request(app()).get('/api/tray/sources').expect(200);
    expect(res.body.sources).toHaveLength(0);
    expect(res.body.ignored).toEqual([
      { connector: 'github', resource_id: 'someone-else/thing', label: 'someone-else/thing', is_repo: true },
    ]);
  });

  /**
   * The whole point of ignoring being a row: tomorrow's push from a repo you
   * dismissed must not be back in the tray. Asking twice is the failure.
   */
  it('stays dismissed when something new arrives from the same source', async () => {
    await arrive('someone-else/thing', 'd1');
    await request(app()).post('/api/tray/ignore').send({ connector: 'github', resource_id: 'someone-else/thing' });

    await arrive('someone-else/thing', 'd2');
    expect((await request(app()).get('/api/tray/sources')).body.sources).toHaveLength(0);
    expect((await request(app()).get('/api/tray')).body).toHaveLength(0);
  });

  it('takes it back, and everything from that source returns', async () => {
    await arrive('someone-else/thing', 'd1');
    await request(app()).post('/api/tray/ignore').send({ connector: 'github', resource_id: 'someone-else/thing' });
    await request(app()).post('/api/tray/unignore').send({ connector: 'github', resource_id: 'someone-else/thing' }).expect(200);

    const res = await request(app()).get('/api/tray/sources');
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.ignored).toHaveLength(0);
  });

  it('ignoring twice is not an error', async () => {
    await arrive('someone-else/thing', 'd1');
    const body = { connector: 'github', resource_id: 'someone-else/thing' };
    await request(app()).post('/api/tray/ignore').send(body).expect(200);
    await request(app()).post('/api/tray/ignore').send(body).expect(200);
    expect((await request(app()).get('/api/tray/sources')).body.ignored).toHaveLength(1);
  });

  it('400s on watch or ignore without a source', async () => {
    await request(app()).post('/api/tray/watch').send({ connector: 'github' }).expect(400);
    await request(app()).post('/api/tray/ignore').send({}).expect(400);
  });
});
