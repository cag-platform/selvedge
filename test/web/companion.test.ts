import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { cards, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createCompanionRouter } from '../../src/server/web/routes/companion.js';
import { createCompanionKeysRouter } from '../../src/server/web/routes/companionKeys.js';
import { issueCompanionToken } from '../../src/server/companion/tokens.js';
import { listExternalSessions } from '../../src/server/companion/sessions.js';
import { appWithOrg } from './helpers.js';

/**
 * The loop's door. It is the only surface in this product a program can knock
 * on without a person behind it, so the tests are mostly about the door itself:
 * nothing gets in without a live key, a key only ever opens its own org, and
 * what comes back out is read-only.
 */
describe('web/routes/companion — the door a machine knocks on', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let token: string;

  const app = () => {
    const server = express();
    server.use(express.json());
    server.use(createCompanionRouter(db));
    return server;
  };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
    await createPack(
      db,
      'org_1',
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A made-to-measure curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    token = (await issueCompanionToken(db, 'org_1', 'laptop')).token;
  });
  afterEach(async () => close());

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  it('lets a live key in, and nothing else', async () => {
    expect((await request(app()).get('/api/companion/hello').set(auth())).status).toBe(200);
    expect((await request(app()).get('/api/companion/hello')).status).toBe(401);
    expect((await request(app()).get('/api/companion/hello').set(auth('slv_wrong'))).status).toBe(401);
    expect((await request(app()).get('/api/companion/hello').set({ Authorization: 'Basic hello' })).status).toBe(401);
    // The same words every time: which kind of wrong it was is nobody's business.
    const a = await request(app()).get('/api/companion/hello');
    const b = await request(app()).get('/api/companion/hello').set(auth('slv_wrong'));
    expect(a.body.error).toBe(b.body.error);
  });

  it('accepts a session summary and files it under its project', async () => {
    const res = await request(app())
      .post('/api/companion/sessions')
      .set(auth())
      .send({
        agent: 'claude-code',
        session_id: 'sess-1',
        outcome: 'ended',
        repo: 'acme/loom',
        intent: 'fix the checkout',
        files_touched: ['src/Cart.tsx'],
        tools_run: { Edit: 2 },
      });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ recorded: true, project_id: 'loom' });
    expect(await listExternalSessions(db, 'org_1')).toHaveLength(1);
  });

  it('says so when it cannot match the directory to a project', async () => {
    const res = await request(app())
      .post('/api/companion/sessions')
      .set(auth())
      .send({ agent: 'codex', session_id: 'orphan', outcome: 'ended', repo: 'someone/else' });
    expect(res.status).toBe(202);
    expect(res.body.project_id).toBeNull();
    expect(res.body.note).toMatch(/couldn't match that directory/i);
  });

  it('refuses a summary that is not one', async () => {
    const bad = async (body: unknown) => (await request(app()).post('/api/companion/sessions').set(auth()).send(body as object)).status;
    expect(await bad({})).toBe(400);
    // An agent nobody has written a reader for. `cursor` and `gemini-cli` ARE
    // legal now — unverified readers, but legal — so the illegal example has to
    // be something genuinely outside the table, or the test stops testing.
    expect(await bad({ agent: 'notepad', session_id: 'x', outcome: 'ended' })).toBe(400);
    expect(await bad({ agent: 'codex', outcome: 'ended' })).toBe(400);
    expect(await bad({ agent: 'codex', session_id: 'x', outcome: 'vanished' })).toBe(400);
  });

  it('takes a session from an unverified reader like any other — a labelled reader is still a real one', async () => {
    for (const agent of ['cursor', 'gemini-cli']) {
      const res = await request(app())
        .post('/api/companion/sessions')
        .set(auth())
        .send({ agent, session_id: `s-${agent}`, outcome: 'unreadable', detail: 'the log never said which session it was' });
      expect(res.status).toBe(202);
    }
  });

  it('serves the project context an agent mounts it for', async () => {
    const res = await request(app()).get('/api/companion/context/loom').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('Loom');
    expect(res.body.text).toContain('made-to-measure curtain shop');
    // The honesty line rides with every pack served.
    expect(res.body.text).toMatch(/Selvedge did not see it — not that it did not happen/i);

    const changes = await request(app()).get('/api/companion/context/loom/changes?days=7').set(auth());
    expect(changes.body.days).toBe(7);
    expect(Array.isArray(changes.body.changes)).toBe(true);

    const issues = await request(app()).get('/api/companion/context/loom/issues').set(auth());
    expect(Array.isArray(issues.body.issues)).toBe(true);
  });

  it('marks an observed session as observed wherever it is served', async () => {
    await request(app())
      .post('/api/companion/sessions')
      .set(auth())
      .send({ agent: 'codex', session_id: 'obs-1', outcome: 'shipped', repo: 'acme/loom', intent: 'the footer', commit_sha: 'a1b2c3d4e5' });
    const changes = await request(app()).get('/api/companion/context/loom/changes').set(auth());
    const said = (changes.body.changes as string[]).join('\n');
    expect(said).toMatch(/Observed from outside \(Selvedge did not run this\)/);
    expect(said).toContain('the footer');
  });

  it('reports what is open, including what it cannot see through', async () => {
    await db.insert(cards).values({
      id: 'c1',
      orgId: 'org_1',
      projectId: 'loom',
      trigger: 'request',
      title: 'a dark header',
      proposal: 'x',
      risk: 'ordinary',
      gate: 'normal',
      state: 'proposed',
      estimate: {},
      stop: {},
      acts: [],
    });
    const res = await request(app()).get('/api/companion/context/loom/issues').set(auth());
    expect((res.body.issues as string[]).join('\n')).toMatch(/Waiting for the owner to approve: a dark header/);
  });

  it('a key opens its own org and no other', async () => {
    const other = (await issueCompanionToken(db, 'org_2', 'their laptop')).token;
    expect((await request(app()).get('/api/companion/context/loom').set(auth(other))).status).toBe(404);
    expect((await request(app()).get('/api/companion/hello').set(auth(other))).body.projects).toEqual([]);
  });

  it('is read-only: there is no way in through this door to change anything', async () => {
    expect((await request(app()).post('/api/companion/context/loom').set(auth()).send({ text: 'mine now' })).status).toBe(404);
    expect((await request(app()).delete('/api/companion/context/loom').set(auth())).status).toBe(404);
  });
});

describe('web/routes/companionKeys — the owner\'s side', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('mints a key once, lists it without the secret, and can stop it working', async () => {
    const app = appWithOrg('org_1', createCompanionKeysRouter(db));
    const made = await request(app).post('/api/companion-keys').send({ name: 'my laptop' });
    expect(made.status).toBe(201);
    expect(made.body.token.startsWith('slv_')).toBe(true);
    expect(made.body.note).toMatch(/shown only once/i);

    const listed = await request(app).get('/api/companion-keys');
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.token);

    expect((await request(app).delete(`/api/companion-keys/${made.body.id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/companion-keys/${made.body.id}`)).status).toBe(404);
  });

  it('one org cannot revoke another org\'s key', async () => {
    const mine = await request(appWithOrg('org_1', createCompanionKeysRouter(db))).post('/api/companion-keys').send({ name: 'laptop' });
    const theirs = appWithOrg('org_2', createCompanionKeysRouter(db));
    expect((await request(theirs).delete(`/api/companion-keys/${mine.body.id}`)).status).toBe(404);
    expect((await request(theirs).get('/api/companion-keys')).body.keys).toEqual([]);
  });
});
