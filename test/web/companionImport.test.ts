import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, threads } from '../../src/server/db/schema/index.js';
import { createCompanionRouter } from '../../src/server/web/routes/companion.js';
import { issueCompanionToken } from '../../src/server/companion/tokens.js';

/**
 * THE DOOR FOR HISTORIES NO VENDOR EXPORTS.
 *
 * Cursor's chats live in a local SQLite file; the companion CLI reads them and
 * sends them here. Same pipe as the zip imports underneath — the properties
 * worth holding are the pipe's: dedupe by (vendor, sourceId) so re-running the
 * command never doubles a history, org isolation, and unreadable things
 * counted rather than dropped.
 */
describe('companion import — conversations with no export file', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let token: string;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    token = (await issueCompanionToken(db, orgId, 'laptop')).token;
  });
  afterEach(async () => close());

  const app = () => {
    const a = express();
    a.use(express.json({ limit: '25mb' }));
    a.use(createCompanionRouter(db));
    return a;
  };

  const convo = (sourceId: string, text = 'hello from cursor') => ({
    sourceId,
    title: `About ${sourceId}`,
    startedAt: '2026-08-01T10:00:00.000Z',
    messages: [
      { role: 'owner' as const, content: text, at: null },
      { role: 'agent' as const, content: 'noted', at: null },
    ],
  });

  const send = (body: unknown, t = token) =>
    request(app()).post('/api/companion/import/conversations').set('Authorization', `Bearer ${t}`).send(body as object);

  it('files conversations under "Cursor history" and says so', async () => {
    const res = await send({ vendor: 'cursor', conversations: [convo('c1'), convo('c2')], unreadable: [] });
    expect(res.status).toBe(200);
    expect(res.body.filed).toBe(2);
    expect(res.body.summary).toContain('Cursor');

    const rows = await db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.importedFrom, 'cursor')));
    expect(rows).toHaveLength(2);
  });

  /** Re-running `selvedge import cursor` must be a no-op, not a doubling. */
  it('a second run of the same history duplicates nothing', async () => {
    await send({ vendor: 'cursor', conversations: [convo('c1')], unreadable: [] });
    const again = await send({ vendor: 'cursor', conversations: [convo('c1')], unreadable: [] });
    expect(again.body.filed).toBe(0);
    expect(again.body.already_had).toBe(1);
  });

  it('carries the CLI parser’s failures into the count, so the summary covers the whole history', async () => {
    const res = await send({
      vendor: 'cursor',
      conversations: [convo('c1')],
      unreadable: [{ ref: 'comp-9', reason: 'not JSON' }],
    });
    expect(res.body.unreadable).toBeGreaterThanOrEqual(1);
  });

  it('a conversation with a broken shape is counted, and the rest still land', async () => {
    const res = await send({
      vendor: 'cursor',
      conversations: [convo('good'), { sourceId: '', title: 'no id', messages: [{ role: 'owner', content: 'x', at: null }] }],
      unreadable: [],
    });
    expect(res.body.filed).toBe(1);
    expect(res.body.unreadable).toBe(1);
  });

  it('refuses vendors whose exports already have a door', async () => {
    const res = await send({ vendor: 'chatgpt', conversations: [convo('c1')], unreadable: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('web');
  });

  it('never files into another org', async () => {
    const theirs = (await issueCompanionToken(db, 'org_2', 'their laptop')).token;
    await send({ vendor: 'cursor', conversations: [convo('c1')], unreadable: [] }, theirs);
    const mine = await db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.importedFrom, 'cursor')));
    expect(mine).toHaveLength(0);
  });

  it('a bad key is a 401, identical whatever is wrong with it', async () => {
    const res = await send({ vendor: 'cursor', conversations: [], unreadable: [] }, 'slv_not_a_key');
    expect(res.status).toBe(401);
  });
});
