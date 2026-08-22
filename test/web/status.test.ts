import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { narrations, orgs, trustIncidents } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createStatusRouter } from '../../src/server/web/routes/status.js';
import { appWithOrg } from './helpers.js';

/**
 * STATUS — what is left of the daily brief, beside the projects it is about.
 *
 * The correction rule ("when I said this was fine and it wasn't, I say so out
 * loud") had NO test at all while it lived on the brief page, which is exactly
 * how a rule like that rots. It matters more now, not less: reading a
 * correction is what marks it shown, so exactly one surface may own that. A
 * correction acknowledged by a page nobody opens is a correction nobody saw.
 */
describe('status — corrections and what has happened', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }),
    );
  });
  afterEach(async () => close());

  const app = () => appWithOrg(orgId, createStatusRouter(db));

  async function falseAllClear(detail: string) {
    const id = ulid();
    await db.insert(trustIncidents).values({
      id,
      orgId,
      projectId: 'loom',
      kind: 'false_all_clear',
      detail,
      acknowledged: false,
    });
    return id;
  }

  async function happened(fragment: string, at = new Date()) {
    await db.insert(narrations).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      eventId: ulid(),
      eventType: 'deploy.succeeded',
      occurredAt: at,
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      kind: 'moved',
      fragment,
      createdAt: at,
    });
  }

  it('owns the miss out loud, in the words the incident recorded', async () => {
    await falseAllClear('Yesterday I said checkout was fine. It had been failing for six hours.');

    const res = await request(app()).get('/api/status').expect(200);
    expect(res.body.corrections).toHaveLength(1);
    expect(res.body.corrections[0].line).toContain('checkout was fine');
    expect(res.body.corrections[0].project_id).toBe('loom');
  });

  /** The rule the move had to preserve: reading it is what marks it shown. */
  it('marks a correction acknowledged once it has actually been shown', async () => {
    const id = await falseAllClear('I got that wrong.');

    const [before] = await db.select().from(trustIncidents).where(eq(trustIncidents.id, id));
    expect(before!.acknowledged).toBe(false);

    await request(app()).get('/api/status').expect(200);

    const [after] = await db.select().from(trustIncidents).where(eq(trustIncidents.id, id));
    expect(after!.acknowledged).toBe(true);
  });

  it('does not say it twice', async () => {
    await falseAllClear('I got that wrong.');
    await request(app()).get('/api/status');
    expect((await request(app()).get('/api/status')).body.corrections).toHaveLength(0);
  });

  /**
   * A correction that never says nothing. If the incident carried no detail,
   * the plain admission stands on its own rather than being dropped.
   */
  it('still admits it when the incident recorded no words', async () => {
    await db.insert(trustIncidents).values({
      id: ulid(),
      orgId,
      projectId: 'loom',
      kind: 'false_all_clear',
      acknowledged: false,
    });

    const res = await request(app()).get('/api/status');
    expect(res.body.corrections).toHaveLength(1);
    expect(res.body.corrections[0].line).toMatch(/wasn't/i);
  });

  it('carries what has happened, with the project it happened to', async () => {
    await happened('Loom deployed cleanly.');

    const res = await request(app()).get('/api/status').expect(200);
    expect(res.body.live).toHaveLength(1);
    expect(res.body.live[0].fragment).toBe('Loom deployed cleanly.');
    expect(res.body.live[0].project_name).toBe('Loom');
  });

  it('speaks in the project’s own register, not one register for everyone', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'sild', name: 'SILD', owner_description: 'x' },
        voice: { detail_level: 'plain_only', notify: { push_threshold: 'failures' } },
      }),
    );
    await db.insert(narrations).values({
      id: ulid(),
      orgId,
      projectId: 'sild',
      eventId: ulid(),
      eventType: 'deploy.failed',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      kind: 'attention',
      fragment: 'A deploy failed.',
      technicalDetail: 'exit 1',
    });

    const res = await request(app()).get('/api/status');
    expect(res.body.live.find((n: { project_name: string }) => n.project_name === 'SILD').detail_level).toBe('plain_only');
  });

  /** Something with no project yet must still be reachable, never plain_only. */
  it('gives an unplaced event the register that keeps its why reachable', async () => {
    await db.insert(narrations).values({
      id: ulid(),
      orgId,
      projectId: null,
      eventId: ulid(),
      eventType: 'connector.auth_failed',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      kind: 'attention',
      fragment: 'GitHub stopped answering.',
    });

    const res = await request(app()).get('/api/status');
    expect(res.body.live[0].detail_level).toBe('plain_expandable');
    expect(res.body.live[0].project_name).toBeNull();
  });

  it('says nothing at all when there is nothing to say', async () => {
    const res = await request(app()).get('/api/status').expect(200);
    expect(res.body).toEqual({ corrections: [], live: [] });
  });

  it('never shows another org’s corrections', async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    await db.insert(trustIncidents).values({
      id: ulid(),
      orgId: 'org_2',
      projectId: null,
      kind: 'false_all_clear',
      detail: 'not yours',
      acknowledged: false,
    });

    expect((await request(app()).get('/api/status')).body.corrections).toHaveLength(0);
  });
});
