import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, threads, agentMessages } from '../../src/server/db/schema/index.js';
import { titleFromFirstMessage } from '../../src/server/threads/store.js';

/**
 * MIGRATION 0035 — naming the conversations that predate auto-titling.
 *
 * The migration has already run once by the time a test database exists (the
 * harness applies the whole chain), so this test applies the statement again
 * against seeded rows. That is also a property worth having on its own: the
 * backfill must be safe to run against a database it has already visited.
 *
 * The SQL is a re-implementation of titleFromFirstMessage in Postgres, so the
 * sharpest check here compares the two directly on the same inputs.
 */
describe('0035 — default-titled threads take their name from the first thing said', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const migration = readFileSync('src/server/db/migrations/0035_threads_named.sql', 'utf8');

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  async function seedThread(title: string, firstMessage?: string, laterMessage?: string) {
    const id = ulid();
    await db.insert(threads).values({ id, orgId, projectId: null, kind: 'general', title, agent: 'claude' });
    if (firstMessage !== undefined) {
      await db.insert(agentMessages).values({
        id: ulid(), orgId, projectId: null, threadId: id, role: 'owner', content: firstMessage,
        createdAt: new Date('2026-08-01T10:00:00Z'),
      });
    }
    if (laterMessage !== undefined) {
      await db.insert(agentMessages).values({
        id: ulid(), orgId, projectId: null, threadId: id, role: 'owner', content: laterMessage,
        createdAt: new Date('2026-08-02T10:00:00Z'),
      });
    }
    return id;
  }

  const titleOf = async (id: string) => (await db.select().from(threads).where(eq(threads.id, id)))[0]!.title;

  it('renames the defaults from the FIRST owner message, and agrees with the TS rule', async () => {
    const short = await seedThread('Workshop', 'I want to get this live again as an Xcode app.', 'later words');
    const long = await seedThread(
      'New thread',
      'Please take a careful look at the checkout flow because customers keep abandoning their carts halfway through',
    );
    const preRename = await seedThread('thread', 'fix the login redirect');

    await db.execute(sql.raw(migration));

    expect(await titleOf(short)).toBe(titleFromFirstMessage('I want to get this live again as an Xcode app.'));
    expect(await titleOf(long)).toBe(
      titleFromFirstMessage(
        'Please take a careful look at the checkout flow because customers keep abandoning their carts halfway through',
      ),
    );
    expect((await titleOf(long)).endsWith('…')).toBe(true);
    expect((await titleOf(long)).length).toBeLessThanOrEqual(61);
    expect(await titleOf(preRename)).toBe('fix the login redirect');
  });

  it('leaves chosen names and never-spoken-in defaults alone', async () => {
    const named = await seedThread('Gift notes', 'this must not rename anything');
    const silent = await seedThread('Workshop');
    const agentOnly = await seedThread('Workshop');
    await db.insert(agentMessages).values({
      id: ulid(), orgId, projectId: null, threadId: agentOnly, role: 'agent', content: 'an agent spoke first',
    });

    await db.execute(sql.raw(migration));

    expect(await titleOf(named)).toBe('Gift notes');
    expect(await titleOf(silent)).toBe('Workshop');
    // The agent's words are not the owner's ask; the default stays.
    expect(await titleOf(agentOnly)).toBe('Workshop');
  });
});
