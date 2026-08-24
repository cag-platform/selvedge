import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { zipSync } from 'fflate';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createImportReplitRouter } from '../../src/server/web/routes/importReplit.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { GithubError } from '../../src/server/connectors/github/newRepo.js';
import { appWithOrg } from './helpers.js';

/**
 * THE MIGRATION DOOR: a Repl zip in, a project around a repo the owner
 * controls out. The properties held here are the door's, not GitHub's — repo
 * creation and the push are injected, because what must be true is the
 * ordering (validate before creating, plan gate before repo), the half-state
 * honesty when a push fails after a repo exists, and the retry that layers
 * instead of duplicating.
 */
describe('web/routes/import/replit', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const enc = (s: string) => new TextEncoder().encode(s);
  const goodZip = () => Buffer.from(zipSync({ 'my-repl/index.js': enc('console.log(1)'), 'my-repl/node_modules/x.js': enc('junk') }));

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId, plan: 'studio' }]);
  });
  afterEach(async () => close());

  const pushes: Array<{ repo: string; files: string[]; message: string }> = [];
  const okPush = async (repo: string, files: Array<{ path: string }>, message: string) => {
    pushes.push({ repo, files: files.map((f) => f.path), message });
    return { commitSha: 'c0ffee', branch: 'main', files: files.length };
  };
  const okCreateRepo = async (name: string) => ({ fullName: `acme/${name}` });

  const app = (deps = {}) =>
    appWithOrg(orgId, createImportReplitRouter(db, { createRepo: okCreateRepo, push: okPush, ...deps }));

  const send = (a = app(), fields: Record<string, string> = { name: 'Loom Shop' }) => {
    let req = request(a).post('/api/import/replit');
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', goodZip(), 'repl.zip');
  };

  it('zip → repo → project → workshop, with the junk named', async () => {
    pushes.length = 0;
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe('loom-shop');
    expect(res.body.repo).toBe('acme/loom-shop');
    expect(res.body.thread_id).toBeTruthy();
    expect(res.body.skipped).toEqual(['node_modules']);
    expect(res.body.summary).toContain('node_modules');
    // The junk never reached the push, and the app did.
    expect(pushes[0]!.files).toEqual(['index.js']);
    expect(pushes[0]!.message).toBe('Imported from Replit');
    // And the project genuinely exists, pointed at the minted repo.
    const pack = await getPack(db, orgId, 'loom-shop');
    expect(pack?.topology.sources.some((s) => s.connector === 'github' && s.resource_id === 'acme/loom-shop')).toBe(true);
  });

  /**
   * The half-state, said exactly. A repo was minted, files did not land —
   * "it failed" here costs an hour of confusion; the response names the
   * project and says the retry is safe.
   */
  it('a push failure after the repo exists names the project and the way through', async () => {
    const res = await send(
      app({
        push: async () => {
          throw new GithubError('GitHub responded 502');
        },
      }),
    );
    expect(res.status).toBe(502);
    expect(res.body.project_id).toBe('loom-shop');
    expect(res.body.error).toContain('files did not land');
    expect(res.body.error).toContain('loom-shop');
  });

  it('pushes into an existing project instead of minting a second one', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    pushes.length = 0;
    const res = await send(app(), { project_id: 'loom' });
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe('loom');
    expect(pushes[0]!.repo).toBe('acme/loom');
  });

  it('a bad zip is refused before anything is created', async () => {
    let made = false;
    const a = app({
      createRepo: async () => {
        made = true;
        return { fullName: 'acme/x' };
      },
    });
    const res = await request(a)
      .post('/api/import/replit')
      .field('name', 'X')
      .attach('file', Buffer.from('not a zip'), 'repl.zip');
    expect(res.status).toBe(400);
    expect(made).toBe(false);
  });

  it('demands exactly one of a name or a project', async () => {
    expect((await send(app(), {})).status).toBe(400);
    expect((await send(app(), { name: 'X', project_id: 'loom' })).status).toBe(400);
  });

  it('a project with no repo cannot be pushed into, and says so', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({ identity: { project_id: 'bare', name: 'Bare', owner_description: 'x' }, topology: { sources: [] } }),
    );
    const res = await send(app(), { project_id: 'bare' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('no GitHub repo');
  });
});
