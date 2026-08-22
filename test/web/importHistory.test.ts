import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { zipSync, strToU8 } from 'fflate';
import { and, asc, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, orgs, subjects, threads } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createSubject } from '../../src/server/threads/subjects.js';
import { createImportHistoryRouter } from '../../src/server/web/routes/importHistory.js';
import { appWithOrg } from './helpers.js';

/**
 * IMPORTING A HISTORY, END TO END.
 *
 * The two things that would make this feature dishonest, and the tests that
 * stop them: an import that silently loses part of the file, and an imported
 * chat that becomes indistinguishable from something said to Selvedge.
 */
describe('web/routes/importHistory', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
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
    await close();
  });

  const app = (org = orgId) => appWithOrg(org, createImportHistoryRouter(db));

  const claudeExport = (over: unknown[] = []) =>
    Buffer.from(
      zipSync({
        'conversations.json': strToU8(
          JSON.stringify([
            {
              uuid: 'u1',
              name: 'Pricing the made-to-measure line',
              created_at: '2026-02-03T09:00:00Z',
              chat_messages: [
                { sender: 'human', created_at: '2026-02-03T09:00:00Z', text: 'what should we charge?' },
                { sender: 'assistant', created_at: '2026-02-03T09:01:00Z', text: 'Cost plus forty.' },
              ],
            },
            ...over,
          ]),
        ),
      }),
    );

  function post(buffer: Buffer, fields: Record<string, string>, org = orgId) {
    const req = request(app(org)).post('/api/import/history');
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req.attach('file', buffer, 'export.zip');
  }

  it('files old chats as ordinary threads under a project — and marks where they came from', async () => {
    const res = await post(claudeExport(), { project_id: 'loom' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ vendor: 'claude', filed: 1, already_had: 0, unreadable_count: 0 });

    const [thread] = await db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.projectId, 'loom')));
    expect(thread).toMatchObject({ kind: 'general', title: 'Pricing the made-to-measure line', importedFrom: 'claude', importSourceId: 'u1' });
    // Dated to when it happened, not to when it was imported.
    expect((thread!.createdAt as Date).toISOString()).toBe('2026-02-03T09:00:00.000Z');

    const messages = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.threadId, thread!.id))
      .orderBy(asc(agentMessages.createdAt));
    // The provenance line is first, and says the thing that must never be lost.
    expect(messages[0]!.role).toBe('switch');
    expect(messages[0]!.content).toContain('imported from Claude');
    expect(messages[0]!.content).toContain('Nothing in it was said to Selvedge');
    expect(messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ['owner', 'what should we charge?'],
      ['agent', 'Cost plus forty.'],
    ]);
  });

  it('reports what it could not read in the same breath as what it filed', async () => {
    const res = await post(claudeExport([{ uuid: 'u2' }, { uuid: 'u3', chat_messages: [] }]), { project_id: 'loom' });
    expect(res.body.filed).toBe(1);
    expect(res.body.unreadable_count).toBe(2);
    expect(res.body.unreadable.map((u: { ref: string }) => u.ref)).toEqual(['u2', 'u3']);
    // The one sentence a person reads carries both numbers.
    expect(res.body.summary).toContain('1 conversation from Claude');
    expect(res.body.summary).toMatch(/2 entries in the file I could not read/);
  });

  it('says what the format cannot carry at all', async () => {
    const res = await post(claudeExport(), { project_id: 'loom' });
    expect(res.body.limitations.join(' ')).toMatch(/Attachments and artifacts are not imported/);
  });

  it('importing the same export twice does not double the history', async () => {
    await post(claudeExport(), { project_id: 'loom' });
    const second = await post(claudeExport(), { project_id: 'loom' });
    expect(second.body).toMatchObject({ filed: 0, already_had: 1 });
    expect(await db.select().from(threads).where(eq(threads.orgId, orgId))).toHaveLength(1);
  });

  it('files under a subject when the work belongs to no codebase', async () => {
    const subject = await createSubject(db, orgId, 'Pricing');
    const res = await post(claudeExport(), { subject_id: subject.id });
    expect(res.status).toBe(201);
    const [thread] = await db.select().from(threads).where(eq(threads.orgId, orgId));
    expect(thread).toMatchObject({ projectId: null, subjectId: subject.id });
  });

  it('belongs to the account when no place is named', async () => {
    // The rule this replaces: it used to REFUSE an upload until you picked a
    // project or a subject, which put a filing decision in front of the file
    // and then tied a whole account's history to whichever project happened to
    // be chosen. A year of thinking about six different things is not "about
    // Loom", and once filed there it read as though it were.
    const res = await post(claudeExport(), {});
    expect(res.status).toBe(201);

    // Under the vendor's own name, so it is visible in the rail rather than
    // filed nowhere — reachable by name and findable by nobody is a worse
    // state than being in the wrong place.
    expect(res.body.filed_under).toBe('Claude history');
    expect(res.body.summary).toContain('Claude history');
    expect(res.body.summary).toContain('any conversation can pull one in by name');

    const [thread] = await db.select().from(threads).where(eq(threads.orgId, orgId));
    expect(thread!.projectId).toBeNull();
    expect(thread!.subjectId).not.toBeNull();
  });

  it('reuses that one place on every later import', async () => {
    await post(claudeExport(), {});
    await post(claudeExport(), {});
    const made = await db.select().from(subjects).where(eq(subjects.orgId, orgId));
    expect(made.filter((s) => s.name === 'Claude history')).toHaveLength(1);
  });

  it('still refuses two places at once', async () => {
    expect((await post(claudeExport(), { project_id: 'loom', subject_id: 'anything' })).status).toBe(400);
  });

  it('is org-scoped: another org cannot file into this one\'s project or subject', async () => {
    const subject = await createSubject(db, orgId, 'Pricing');
    expect((await post(claudeExport(), { project_id: 'loom' }, 'org_2')).status).toBe(404);
    expect((await post(claudeExport(), { subject_id: subject.id }, 'org_2')).status).toBe(404);
    expect(await db.select().from(threads).where(eq(threads.orgId, 'org_2'))).toHaveLength(0);
  });

  it('refuses an archive with nothing it knows how to read, and writes nothing', async () => {
    const junk = Buffer.from(zipSync({ 'notes.txt': strToU8('hello') }));
    const res = await post(junk, { project_id: 'loom' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conversations.json/);
    expect(await db.select().from(threads).where(eq(threads.orgId, orgId))).toHaveLength(0);
  });

  it('keeps an undated conversation in order without claiming to know when it happened', async () => {
    const undated = Buffer.from(
      zipSync({
        'conversations.json': strToU8(
          JSON.stringify([{ uuid: 'u9', name: 'No dates anywhere', chat_messages: [{ sender: 'human', text: 'first' }, { sender: 'assistant', text: 'second' }] }]),
        ),
      }),
    );
    await post(undated, { project_id: 'loom' });
    const [thread] = await db.select().from(threads).where(eq(threads.orgId, orgId));
    const messages = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.threadId, thread!.id), eq(agentMessages.role, 'owner')))
      .orderBy(asc(agentMessages.createdAt));
    expect(messages[0]!.content).toBe('first');
    // The stamp exists so the conversation reads in order; it is flagged as
    // not a real date, so nothing downstream can present it as one.
    expect((messages[0]!.meta as { imported: { dated: boolean } }).imported.dated).toBe(false);
  });
});
