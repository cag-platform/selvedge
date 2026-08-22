import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import {
  createSubject,
  getSubject,
  listSubjects,
  renameSubject,
  setSubjectArchived,
  threadsForSubject,
} from '../../src/server/threads/subjects.js';
import { createSubjectThread, getThread } from '../../src/server/threads/store.js';
import { runChatTurn } from '../../src/server/chat/turn.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { createSubjectsRouter } from '../../src/server/web/routes/subjects.js';
import { createThreadsRouter } from '../../src/server/web/routes/threads.js';
import { appWithOrg } from '../web/helpers.js';
import { eq } from 'drizzle-orm';

/**
 * Somewhere to put work that isn't a repository.
 *
 * The reason this exists: before it, a conversation about pricing had to be
 * filed under whichever project was least wrong, and a project's history stops
 * being true the moment it contains things that didn't happen to it.
 */
describe('subjects', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
  });
  afterEach(async () => close());

  it('holds conversations that belong to no project', async () => {
    const subject = await createSubject(db, orgId, 'Pricing');
    const thread = await createSubjectThread(db, orgId, subject.id, { title: 'Should we do subscriptions?' });

    expect(thread.projectId).toBeNull();
    expect(thread.subjectId).toBe(subject.id);
    // Always a plain conversation: there is no codebase here to build in, and
    // offering a builder would be a lie about what this thread can do.
    expect(thread.kind).toBe('general');
    expect((await threadsForSubject(db, orgId, subject.id)).map((t) => t.id)).toEqual([thread.id]);
  });

  it('a subject thread talks, and its messages belong to no project either', async () => {
    const subject = await createSubject(db, orgId, 'Pricing');
    const thread = await createSubjectThread(db, orgId, subject.id, { title: 'Subscriptions' });
    const client = new FakeLlmClient((req) => ({ ok: true, json: { reply: 'Probably not yet.' }, tokensIn: 10, tokensOut: 10, model: req.model }));

    const out = await runChatTurn(db, orgId, thread, 'is a subscription worth it?', { client });
    expect(out).toMatchObject({ ok: true, reply: 'Probably not yet.' });

    const messages = await db.select().from(agentMessages).where(eq(agentMessages.threadId, thread.id));
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.projectId === null)).toBe(true);
    // With no project behind it there is no project context to give, and the
    // model is not handed one invented from the subject's name.
    expect(client.requests[0]!.userContent).toMatch(/no context pack for this project/i);
  });

  it('renames and archives, and archiving keeps the conversations', async () => {
    const subject = await createSubject(db, orgId, 'Priceing');
    const thread = await createSubjectThread(db, orgId, subject.id, {});
    expect(await renameSubject(db, orgId, subject.id, 'Pricing')).toBe(true);
    expect((await getSubject(db, orgId, subject.id))!.name).toBe('Pricing');
    expect(await renameSubject(db, orgId, subject.id, '  ')).toBe(false);

    expect(await setSubjectArchived(db, orgId, subject.id, true)).toBe(true);
    expect(await listSubjects(db, orgId)).toHaveLength(0);
    expect(await listSubjects(db, orgId, { includeArchived: true })).toHaveLength(1);
    // The folder was put away; what was in it is still the record.
    expect(await getThread(db, orgId, thread.id)).not.toBeNull();
  });

  it('is org-scoped', async () => {
    const subject = await createSubject(db, orgId, 'Pricing');
    expect(await getSubject(db, 'org_2', subject.id)).toBeNull();
    expect(await listSubjects(db, 'org_2')).toEqual([]);
    expect(await renameSubject(db, 'org_2', subject.id, 'theirs')).toBe(false);
  });
});

describe('subjects on the rail and over HTTP', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c', githubToken: 'g' });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
  });
  afterEach(async () => close());

  const subjectsApp = () => appWithOrg(orgId, createSubjectsRouter(db));
  const threadsApp = () => appWithOrg(orgId, createThreadsRouter(db, { env: engineOn }));

  it('makes a subject, starts a conversation in it, and shows both on the rail', async () => {
    const made = await request(subjectsApp()).post('/api/subjects').send({ name: 'Pricing' });
    expect(made.status).toBe(201);

    const thread = await request(threadsApp()).post(`/api/subjects/${made.body.subject.id}/threads`).send({ title: 'Subscriptions' });
    expect(thread.status).toBe(201);
    expect(thread.body.thread.kind).toBe('general');

    const rail = await request(threadsApp()).get('/api/inbox');
    expect(rail.body.subjects).toHaveLength(1);
    expect(rail.body.subjects[0].name).toBe('Pricing');
    expect(rail.body.subjects[0].threads[0].title).toBe('Subscriptions');
    // A subject carries no status, because there is nothing about it to be
    // right or wrong about.
    expect(rail.body.subjects[0].status).toBeUndefined();
  });

  it('the thread pane knows it is about a subject, not a project', async () => {
    const made = await request(subjectsApp()).post('/api/subjects').send({ name: 'Pricing' });
    const created = await request(threadsApp()).post(`/api/subjects/${made.body.subject.id}/threads`).send({});
    const pane = await request(threadsApp()).get(`/api/threads/${created.body.thread.id}`);
    expect(pane.body.project).toBeNull();
    expect(pane.body.subject).toMatchObject({ name: 'Pricing' });
  });

  /**
   * A builder may be asked into any conversation — the picker must not lie
   * about who is available. What it cannot do is build where there is no
   * codebase, and that is said at the moment it is asked to, in the words of
   * the thing that is actually missing.
   */
  it('lets a builder in, then says plainly there is nothing here to build in', async () => {
    const made = await request(subjectsApp()).post('/api/subjects').send({ name: 'Pricing' });
    const created = await request(threadsApp()).post(`/api/subjects/${made.body.subject.id}/threads`).send({});
    const threadId = created.body.thread.id;

    const switched = await request(threadsApp()).patch(`/api/threads/${threadId}`).send({ agent: 'claude-code' });
    expect(switched.status).toBe(200);

    const res = await request(threadsApp()).post(`/api/threads/${threadId}/message`).send({ text: 'build it' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/nothing here to build in/i);
  });

  it('a subject needs a name, and belongs to one org', async () => {
    expect((await request(subjectsApp()).post('/api/subjects').send({ name: '   ' })).status).toBe(400);
    const made = await request(subjectsApp()).post('/api/subjects').send({ name: 'Pricing' });
    const theirs = appWithOrg('org_2', createSubjectsRouter(db));
    expect((await request(theirs).get('/api/subjects')).body.subjects).toEqual([]);
    expect((await request(theirs).patch(`/api/subjects/${made.body.subject.id}`).send({ archived: true })).status).toBe(404);
  });
});
