import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThreadsRouter, type ThreadsDeps } from '../../src/server/web/routes/threads.js';
import { createThread, ensureWorkshopThread } from '../../src/server/threads/store.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { createSubjectThread } from '../../src/server/threads/store.js';
import { appWithOrg } from './helpers.js';

/**
 * A paste too long to be a sentence rides beside the message. Three things
 * have to hold: the whole of it reaches whoever answers, the thread keeps it
 * as the record, and watching a conversation that has one doesn't mean
 * re-downloading it every few seconds.
 */
describe('web/routes/threads — attached documents', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const engineOn = () => ({ claudeCodeOauthToken: 'c' });
  const rundown = `# The rundown\n\n${'The house style is worth preserving. '.repeat(300)}THE LAST LINE MATTERS.`;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }]);
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
    await close();
  });

  function captureTurn() {
    let seen: ((value: { handoff?: string; documents?: Array<{ name: string; text: string }> }) => void) | null = null;
    const called = new Promise<{ handoff?: string; documents?: Array<{ name: string; text: string }> }>((resolve) => {
      seen = resolve;
    });
    const runTurn = (async (_d: unknown, _o: unknown, _p: unknown, _t: unknown, _c: unknown, options?: never) => {
      seen?.(options ?? {});
      return { runId: 'r', agent: 'claude-code', status: 'succeeded', costCents: 0, reply: 'ok', stagedChangesReady: false };
    }) as ThreadsDeps['runTurn'];
    return { runTurn, called };
  }

  it('hands the whole document to a build turn, not its opening', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const { runTurn, called } = captureTurn();
    const app = appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));

    const res = await request(app)
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: 'what do you make of this?', documents: [{ text: rundown }] });
    expect(res.status).toBe(202);

    const options = await called;
    expect(options.documents?.[0]!.text).toContain('THE LAST LINE MATTERS');
    // Named from what it says, so a chip is identifiable without opening it.
    expect(options.documents?.[0]!.name).toBe('The rundown');
  });

  it('keeps it on the thread, but sends only its name and size with the conversation', async () => {
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Thinking', agent: 'claude' });
    const app = appWithOrg(
      orgId,
      createThreadsRouter(db, {
        env: engineOn,
        chatTurn: (async () => ({ ok: true, reply: 'noted', model: 'm', costed: false })) as ThreadsDeps['chatTurn'],
      }),
    );
    // The consultation path writes the owner's message itself, so it is the one
    // that proves the record without a real turn behind it.
    await request(app)
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: '@claude @gpt what do you make of this?', documents: [{ text: rundown }] });

    const [owner] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.role, 'owner')));
    // The record holds the whole thing.
    expect(JSON.stringify(owner!.meta)).toContain('THE LAST LINE MATTERS');

    // The payload doesn't: a thread is polled every few seconds.
    const view = await request(app).get(`/api/threads/${thread.id}`);
    const message = view.body.messages.find((m: { role: string }) => m.role === 'owner');
    expect(message.documents).toEqual([{ index: 0, name: 'The rundown', chars: rundown.length }]);
    expect(JSON.stringify(view.body)).not.toContain('THE LAST LINE MATTERS');

    // And it is one request away when somebody opens it.
    const doc = await request(app).get(`/api/threads/${thread.id}/documents/${message.id}/0`);
    expect(doc.status).toBe(200);
    expect(doc.body.name).toBe('The rundown');
    expect(doc.body.text).toContain('THE LAST LINE MATTERS');
  });

  it('works in a thread that belongs to a subject, which has no project', async () => {
    // The reason this endpoint is thread-scoped rather than project-scoped like
    // the image attachments beside it.
    const subject = await createSubject(db, orgId, 'Pricing');
    const thread = await createSubjectThread(db, orgId, subject.id, { title: 'Thinking', agent: 'claude' });
    const app = appWithOrg(
      orgId,
      createThreadsRouter(db, {
        env: engineOn,
        chatTurn: (async () => ({ ok: true, reply: 'noted', model: 'm', costed: false })) as ThreadsDeps['chatTurn'],
      }),
    );
    await request(app)
      .post(`/api/threads/${thread.id}/message`)
      .send({ text: '@claude @gpt thoughts?', documents: [{ text: rundown }] });

    const view = await request(app).get(`/api/threads/${thread.id}`);
    const message = view.body.messages.find((m: { role: string }) => m.role === 'owner');
    const doc = await request(app).get(`/api/threads/${thread.id}/documents/${message.id}/0`);
    expect(doc.status).toBe(200);
    expect(doc.body.text).toContain('THE LAST LINE MATTERS');
  });

  it('never hands a document to another org', async () => {
    await db.insert(orgs).values([{ orgId: 'org_2' }]);
    const thread = await createThread(db, orgId, 'loom', { kind: 'general', title: 'Thinking', agent: 'claude' });
    const mine = appWithOrg(
      orgId,
      createThreadsRouter(db, { env: engineOn, chatTurn: (async () => ({ ok: true, reply: 'x', model: 'm', costed: false })) as ThreadsDeps['chatTurn'] }),
    );
    await request(mine).post(`/api/threads/${thread.id}/message`).send({ text: '@claude @gpt ?', documents: [{ text: rundown }] });
    const view = await request(mine).get(`/api/threads/${thread.id}`);
    const message = view.body.messages.find((m: { role: string }) => m.role === 'owner');

    const theirs = appWithOrg('org_2', createThreadsRouter(db, { env: engineOn }));
    const denied = await request(theirs).get(`/api/threads/${thread.id}/documents/${message.id}/0`);
    expect(denied.status).toBe(404);
  });

  it('says nothing when nothing was attached', async () => {
    const thread = await ensureWorkshopThread(db, orgId, 'loom');
    const { runTurn, called } = captureTurn();
    const app = appWithOrg(orgId, createThreadsRouter(db, { env: engineOn, runTurn }));
    await request(app).post(`/api/threads/${thread.id}/message`).send({ text: 'just build it' });
    expect((await called).documents).toBeUndefined();
  });
});
