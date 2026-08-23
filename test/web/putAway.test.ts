import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { ensureWorkshopThread } from '../../src/server/threads/store.js';
import { listReferenceCandidates } from '../../src/server/references/resolve.js';
import { appWithOrg } from './helpers.js';

/**
 * PUT AWAY — a place you are not working in right now.
 *
 * The rail is one list of everywhere you work, and it is the right length at
 * four places and the wrong length at forty. A rail you scroll past is a rail
 * you stop reading, which costs the product's oldest acceptance test: that a
 * stranger reads the whole stack's health from the edges alone.
 *
 * So the properties worth holding hardest are the ones that say what putting
 * something away is NOT. It is not a delete, not an un-watch, and not a thing
 * that can happen to you quietly.
 */
describe('a place you are not working in right now', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c' });
  const app = () => appWithOrg(orgId, createThreadsRouter(db, { env: engineOn }));

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'mirror', name: 'Mirror', owner_description: 'An old thing.' } }));
  });
  afterEach(async () => {
    await close();
  });

  const inbox = async () => (await request(app()).get('/api/inbox')).body;

  it('folds a project out of the rail, and says how many are folded', async () => {
    const before = await inbox();
    expect(before.projects.map((p: { put_away: boolean }) => p.put_away)).toEqual([false, false]);

    const res = await request(app()).patch('/api/inbox/places/mirror').send({ put_away: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, put_away: true, kind: 'project' });

    // Still in the payload — the rail folds it and counts it, rather than
    // being told a shorter truth about how much there is.
    const after = await inbox();
    expect(after.projects).toHaveLength(2);
    expect(after.projects.find((p: { id: string }) => p.id === 'mirror').put_away).toBe(true);
    expect(after.projects.find((p: { id: string }) => p.id === 'loom').put_away).toBe(false);
  });

  it('does the same for a place with no repo, through the same call', async () => {
    // The rail is one list on purpose. If the client had to know which kind of
    // row it was holding before it could fold it, the distinction would be
    // back in the one component whose whole job is that it doesn't matter.
    const subject = await createSubject(db, orgId, 'Pricing');
    const res = await request(app()).patch(`/api/inbox/places/${subject.id}`).send({ put_away: true });
    expect(res.body).toEqual({ ok: true, put_away: true, kind: 'subject' });

    const after = await inbox();
    expect(after.subjects.find((s: { id: string }) => s.id === subject.id).put_away).toBe(true);
  });

  it('brings it back, and the conversation is exactly where it was', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'mirror');
    await request(app()).patch('/api/inbox/places/mirror').send({ put_away: true });
    await request(app()).patch('/api/inbox/places/mirror').send({ put_away: false });

    const after = await inbox();
    const mirror = after.projects.find((p: { id: string }) => p.id === 'mirror');
    expect(mirror.put_away).toBe(false);
    expect(mirror.threads.map((t: { id: string }) => t.id)).toEqual([thread.id]);
  });

  it('is not a delete: the project keeps its health line and its history', async () => {
    await request(app()).patch('/api/inbox/places/loom').send({ put_away: true });
    const loom = (await inbox()).projects.find((p: { id: string }) => p.id === 'loom');
    // Whatever the rail would have said about it, it still says when opened.
    // A folded row is a row you chose not to look at, not a row we stopped
    // knowing anything about.
    expect(loom).toHaveProperty('status');
    expect(loom).toHaveProperty('health');
  });

  it('is still something you can point at with #', async () => {
    // The reason this is a fold and not a filter. Putting a repo away means "I
    // am not working in it", not "forget it exists" — and drawing on an old
    // project from a new conversation is the entire point of references.
    await request(app()).patch('/api/inbox/places/mirror').send({ put_away: true });
    const candidates = await listReferenceCandidates(db, orgId);
    expect(candidates.map((c) => c.name)).toContain('Mirror');
  });

  it('refuses a place that is not yours, and one that is not there', async () => {
    const theirs = appWithOrg('org_2', createThreadsRouter(db, { env: engineOn }));
    expect((await request(theirs).patch('/api/inbox/places/loom').send({ put_away: true })).status).toBe(404);
    expect((await request(app()).patch('/api/inbox/places/nonesuch').send({ put_away: true })).status).toBe(404);
    // And the refusal did nothing on the way past.
    expect((await inbox()).projects.find((p: { id: string }) => p.id === 'loom').put_away).toBe(false);
  });

  it('will not be told to do something that is not a yes or a no', async () => {
    const res = await request(app()).patch('/api/inbox/places/loom').send({ put_away: 'yes please' });
    expect(res.status).toBe(400);
  });
});
