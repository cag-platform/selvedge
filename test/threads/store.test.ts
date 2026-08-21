import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, threads } from '../../src/server/db/schema/index.js';
import {
  createThread,
  ensureWorkshopThread,
  getThread,
  listThreads,
  renameThread,
  setThreadAgent,
  setThreadArchived,
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

  it('switches the agent behind a thread, and refuses the switches that make no sense', async () => {
    const workshop = await ensureWorkshopThread(db, 'org_1', 'loom');
    const switched = await setThreadAgent(db, 'org_1', workshop.id, 'codex');
    expect(switched.ok).toBe(true);
    if (switched.ok) expect(switched.thread.agent).toBe('codex');

    // A chat model cannot run a sandbox thread, and an agent nobody declared
    // cannot run anything — both refused before anything is written.
    expect(await setThreadAgent(db, 'org_1', workshop.id, 'gpt')).toEqual({ ok: false, reason: 'wrong_kind' });
    expect(await setThreadAgent(db, 'org_1', workshop.id, 'llama')).toEqual({ ok: false, reason: 'unknown_agent' });
    expect(await setThreadAgent(db, 'org_1', 'no_such_thread', 'codex')).toEqual({ ok: false, reason: 'no_such_thread' });
    expect((await getThread(db, 'org_1', workshop.id))!.agent).toBe('codex');
  });
});
