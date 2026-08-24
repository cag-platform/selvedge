import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, threads } from '../../src/server/db/schema/index.js';
import {
  createThread,
  ensureWorkshopThread,
  getThread,
  isDefaultTitle,
  listThreads,
  renameThread,
  setThreadAgent,
  setThreadArchived,
  titleFromFirstMessage,
} from '../../src/server/threads/store.js';

describe('the thread store — one project, many conversations', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('mints the project workshop thread on first use, and returns that same one forever after', async () => {
    const first = await ensureWorkshopThread(db, 'org_1', 'loom');
    expect(first.kind).toBe('workshop');
    expect(first.agent).toBe('claude-code');
    expect(first.title).toBe('Workshop');

    const again = await ensureWorkshopThread(db, 'org_1', 'loom');
    expect(again.id).toBe(first.id);
    expect(await listThreads(db, 'org_1', 'loom')).toHaveLength(1);
  });

  it('keeps writing into the oldest workshop thread even once newer ones exist', async () => {
    // The history is the product: a project worked on for months must not
    // silently start a second, empty conversation beside the one it has.
    const original = await ensureWorkshopThread(db, 'org_1', 'loom');
    await db.update(threads).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(threads.id, original.id));
    await createThread(db, 'org_1', 'loom', { kind: 'workshop', title: 'A second go' });

    expect((await ensureWorkshopThread(db, 'org_1', 'loom')).id).toBe(original.id);
  });

  it('a general thread is a different kind of thing, with its own default agent', async () => {
    const chat = await createThread(db, 'org_1', 'loom', { kind: 'general', title: 'What should we do about pricing?' });
    expect(chat.kind).toBe('general');
    expect(chat.agent).toBe('claude');
    // ...and it is never handed out as the workshop thread.
    expect((await ensureWorkshopThread(db, 'org_1', 'loom')).id).not.toBe(chat.id);
  });

  it('is org-scoped: one org never reads, renames, or archives another org\'s thread', async () => {
    const mine = await ensureWorkshopThread(db, 'org_1', 'loom');
    expect(await getThread(db, 'org_2', mine.id)).toBeNull();
    expect(await renameThread(db, 'org_2', mine.id, 'stolen')).toBe(false);
    expect(await setThreadArchived(db, 'org_2', mine.id, true)).toBe(false);
    expect((await getThread(db, 'org_1', mine.id))!.title).toBe('Workshop');

    // Two orgs can hold the same project id without ever meeting.
    await ensureWorkshopThread(db, 'org_2', 'loom');
    expect(await listThreads(db, 'org_1', 'loom')).toHaveLength(1);
    expect(await listThreads(db, 'org_2', 'loom')).toHaveLength(1);
  });

  it('renames and archives; archived threads drop out of the list but are never deleted', async () => {
    const thread = await ensureWorkshopThread(db, 'org_1', 'loom');
    expect(await renameThread(db, 'org_1', thread.id, '  Checkout rework  ')).toBe(true);
    expect((await getThread(db, 'org_1', thread.id))!.title).toBe('Checkout rework');
    expect(await renameThread(db, 'org_1', thread.id, '   ')).toBe(false); // a blank name is not a rename

    expect(await setThreadArchived(db, 'org_1', thread.id, true)).toBe(true);
    expect(await listThreads(db, 'org_1', 'loom')).toHaveLength(0);
    expect(await listThreads(db, 'org_1', 'loom', { includeArchived: true })).toHaveLength(1);
    // The record survives archiving — restoring is just the same lever back.
    await setThreadArchived(db, 'org_1', thread.id, false);
    expect(await listThreads(db, 'org_1', 'loom')).toHaveLength(1);
  });

  it('an archived workshop thread is not reused — ensure mints a fresh one', async () => {
    const first = await ensureWorkshopThread(db, 'org_1', 'loom');
    await setThreadArchived(db, 'org_1', first.id, true);
    expect((await ensureWorkshopThread(db, 'org_1', 'loom')).id).not.toBe(first.id);
  });

  it('hands a thread to any agent, and refuses only what does not exist', async () => {
    const workshop = await ensureWorkshopThread(db, 'org_1', 'loom');
    const switched = await setThreadAgent(db, 'org_1', workshop.id, 'codex');
    expect(switched.ok).toBe(true);
    if (switched.ok) expect(switched.thread.agent).toBe('codex');

    // A talker may take over a conversation that has been building — that is
    // the whole point, and it used to be refused.
    const toTalker = await setThreadAgent(db, 'org_1', workshop.id, 'gpt');
    expect(toTalker.ok).toBe(true);
    expect((await getThread(db, 'org_1', workshop.id))!.agent).toBe('gpt');

    // An agent nobody declared still cannot run anything, and neither can a
    // thread that isn't there.
    expect(await setThreadAgent(db, 'org_1', workshop.id, 'llama')).toEqual({ ok: false, reason: 'unknown_agent' });
    expect(await setThreadAgent(db, 'org_1', 'no_such_thread', 'codex')).toEqual({ ok: false, reason: 'no_such_thread' });
    expect((await getThread(db, 'org_1', workshop.id))!.agent).toBe('gpt');
  });
});

/**
 * TWELVE ROWS READING "WORKSHOP".
 *
 * Threads are created as "Workshop" or "New thread" and nothing ever renamed
 * them. That was invisible while the rail showed only project names — and the
 * moment the rail started showing what a place IS, every row said the same
 * word, which is exactly as useful as the blank line it replaced.
 *
 * The first thing the owner says names the room. Their words, not a model's
 * summary: no request, no cost, and no chance of describing the conversation
 * as something it isn't.
 */
describe('naming a conversation after what is in it', () => {
  it('takes a short message whole', () => {
    expect(titleFromFirstMessage('Give me a rundown of this app')).toBe('Give me a rundown of this app');
  });

  it('cuts a long one on a word boundary, never mid-word', () => {
    const long = 'I need you to look at the checkout flow and work out why the basket empties itself when somebody changes a fabric';
    const title = titleFromFirstMessage(long);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    // The cut lands between words: no half-word before the ellipsis.
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(long[title.length - 1] === ' ' || long[title.length - 1] === undefined || /\s/.test(long[title.length - 1]!)).toBe(true);
  });

  it('collapses the whitespace a paste brings with it', () => {
    expect(titleFromFirstMessage('  make   the\n\n  header   sticky ')).toBe('make the header sticky');
  });

  it('never ends on punctuation that reads as a mistake', () => {
    expect(titleFromFirstMessage('fix the header,')).toBe('fix the header');
    expect(titleFromFirstMessage('ship it.')).toBe('ship it');
  });

  it('has nothing to say about an empty message', () => {
    expect(titleFromFirstMessage('   ')).toBe('');
  });

  it('knows which names are nobody\'s choice', () => {
    expect(isDefaultTitle('Workshop')).toBe(true);
    expect(isDefaultTitle('New thread')).toBe(true);
    expect(isDefaultTitle('  ')).toBe(true);
    // A name somebody chose is never overwritten, including one that merely
    // contains the default word.
    expect(isDefaultTitle('Workshop rework')).toBe(false);
    expect(isDefaultTitle('Checkout rework')).toBe(false);
  });
});
