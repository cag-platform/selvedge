import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createWorkshopRouter } from '../../src/server/web/routes/workshop.js';
import { diagnoseStartFailure } from '../../src/server/build/previewDiagnosis.js';
import { previewEnvFile } from '../../src/server/build/previewEnv.js';
import { appWithOrg } from '../web/helpers.js';
import { stubRepoLookup } from '../helpers/repoLookup.js';

/**
 * THE LOOP THAT WAS OPEN AT ONE END.
 *
 * Every piece of this existed except the place a person types. The preview
 * failed, the diagnosis named the missing variable, the hint said "add it to
 * this project's preview environment" — and there was no such screen, so the
 * instruction pointed at nothing. The table, the vault, the encryption and the
 * sandbox upload were all built and all unreachable.
 *
 * What these hold is the loop closed: a failure that names a variable OFFERS
 * the box, the box stores what is typed, and what is stored reaches the thing
 * that starts the app.
 */
describe('the preview environment, end to end', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  const app = (org = orgId) => appWithOrg(org, createWorkshopRouter(db, { lookup: stubRepoLookup, env: () => ({ workspaceRuntime: true as const }) }));

  /**
   * THE HINT NOW POINTS SOMEWHERE. A diagnosis that names a variable has to be
   * able to offer the place to put it, or it is an instruction with no
   * destination — which is worse than saying nothing.
   */
  it('a failure that names a variable offers the box, and one that does not does not', () => {
    const missing = diagnoseStartFailure('Error: Missing required environment variable: STRIPE_SECRET_KEY');
    expect(missing.kind).toBe('missing_env');
    expect(missing.line).toContain('STRIPE_SECRET_KEY');
    expect(missing.hint).toMatch(/preview environment/i);

    // A database failure offers the database, not this.
    expect(diagnoseStartFailure('Error: connect ECONNREFUSED 127.0.0.1:5432').kind).toBe('database');
    // And an unreadable log offers nothing at all.
    expect(diagnoseStartFailure('Compiled successfully').kind).toBe('unknown');
  });

  it('stores what was pasted and reports the names back', async () => {
    const res = await request(app())
      .put('/api/projects/loom/preview-env')
      .send({ env: 'STRIPE_SECRET_KEY=sk_live_abc\nSESSION_SECRET=hunter2\n# a comment\n' })
      .expect(200);

    expect(res.body.keys).toEqual(['STRIPE_SECRET_KEY', 'SESSION_SECRET']);

    const read = await request(app()).get('/api/projects/loom/preview-env').expect(200);
    expect(read.body.keys).toEqual(['STRIPE_SECRET_KEY', 'SESSION_SECRET']);
  });

  /**
   * THE RULE THE WHOLE FEATURE RESTS ON. A screen that can redisplay a secret
   * is a screen that leaks it to whoever is behind you, and an API that can
   * return one is one request away from doing it everywhere.
   */
  it('never returns a value, on any path', async () => {
    await request(app()).put('/api/projects/loom/preview-env').send({ env: 'STRIPE_SECRET_KEY=sk_live_SUPERSECRET' }).expect(200);

    const read = await request(app()).get('/api/projects/loom/preview-env');
    expect(JSON.stringify(read.body)).not.toContain('sk_live_SUPERSECRET');

    const written = await request(app()).put('/api/projects/loom/preview-env').send({ env: 'A=1' });
    expect(JSON.stringify(written.body)).not.toContain('sk_live_SUPERSECRET');
  });

  /** What is stored has to reach the thing that starts the app, or none of it matters. */
  it('reaches the file the sandbox is given', async () => {
    await request(app()).put('/api/projects/loom/preview-env').send({ env: "MSG='it is set'\nPORT=3000" }).expect(200);

    const file = await previewEnvFile(db, orgId, 'loom');
    expect(file).toContain('MSG=');
    expect(file).toContain('it is set');
    expect(file).toContain('PORT=');
  });

  /** A `.env` is a whole file, not a patch — and the screen says so before you save. */
  it('replaces rather than merges, and empties on an empty paste', async () => {
    await request(app()).put('/api/projects/loom/preview-env').send({ env: 'A=1\nB=2\nC=3' }).expect(200);

    const fewer = await request(app()).put('/api/projects/loom/preview-env').send({ env: 'A=9' }).expect(200);
    expect(fewer.body.keys).toEqual(['A']);

    const cleared = await request(app()).put('/api/projects/loom/preview-env').send({ env: '' }).expect(200);
    expect(cleared.body.keys).toEqual([]);
    expect(await previewEnvFile(db, orgId, 'loom')).toBeNull();
  });

  it('refuses a body that is not the text of a file', async () => {
    await request(app()).put('/api/projects/loom/preview-env').send({ env: { STRIPE: 'x' } }).expect(400);
    await request(app()).put('/api/projects/loom/preview-env').send({}).expect(400);
  });

  /**
   * An unconfigured vault is a deployment problem said plainly. Storing
   * somebody's production credentials in the clear "for now" is how they stay
   * in the clear.
   */
  it('will not store secrets at all without a vault key', async () => {
    delete process.env.CREDENTIALS_KEY;
    const res = await request(app()).put('/api/projects/loom/preview-env').send({ env: 'A=1' }).expect(503);
    expect(res.body.error).toMatch(/credentials key/i);
  });

  it("never reads or writes another org's environment", async () => {
    await request(app()).put('/api/projects/loom/preview-env').send({ env: 'MINE=yes' }).expect(200);

    const theirs = await request(app('org_2')).get('/api/projects/loom/preview-env').expect(200);
    expect(theirs.body.keys).toEqual([]);
    expect(await previewEnvFile(db, 'org_2', 'loom')).toBeNull();
  });
});
