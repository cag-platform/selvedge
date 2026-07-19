import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { resolveProjectId } from '../../src/server/resolution/resolveProject.js';
import { matchesKnownFlaky } from '../../src/server/resolution/knownFlaky.js';
import { refineEventType } from '../../src/server/resolution/refineEventType.js';
import { currentLocalTime, pairedOutagePushed, recentPushWorthyCount } from '../../src/server/resolution/routingContext.js';
import { recordConnectorAuthFailed } from '../../src/server/resolution/connectorEvents.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('resolution/resolveProjectId', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('matches by connector + resource_id', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
    expect(await resolveProjectId(db, orgId, 'github', 'acme/test-project')).toBe('loom');
    expect(await resolveProjectId(db, orgId, 'github', 'acme/other')).toBeNull();
    expect(await resolveProjectId(db, orgId, 'railway', 'acme/test-project')).toBeNull();
  });
});

describe('resolution/knownFlaky', () => {
  it('matches case-insensitively against a workflow name', () => {
    const pack = makeTestPack({ baselines: { known_flaky: [{ pattern: 'flaky-e2e' }] } });
    expect(matchesKnownFlaky({ workflow_run: { name: 'Flaky-E2E Suite' } }, pack)).toBe(true);
    expect(matchesKnownFlaky({ workflow_run: { name: 'Unit tests' } }, pack)).toBe(false);
  });

  it('returns false with no patterns or no workflow name', () => {
    const pack = makeTestPack();
    expect(matchesKnownFlaky({ workflow_run: { name: 'anything' } }, pack)).toBe(false);
    const flakyPack = makeTestPack({ baselines: { known_flaky: [{ pattern: 'x' }] } });
    expect(matchesKnownFlaky({}, flakyPack)).toBe(false);
  });
});

describe('resolution/refineEventType', () => {
  it('upgrades deploy.failed_previous_serving only when nothing has ever served', () => {
    const neverServed = makeTestPack();
    expect(refineEventType('deploy.failed_previous_serving', {}, neverServed)).toBe('deploy.failed_nothing_serving');

    const served = makeTestPack({ state: { serving_now: { deployed_at: '2026-01-01T00:00:00Z' } } });
    expect(refineEventType('deploy.failed_previous_serving', {}, served)).toBe('deploy.failed_previous_serving');
  });

  it('leaves other event types untouched', () => {
    const pack = makeTestPack();
    expect(refineEventType('code.pr_opened', {}, pack)).toBe('code.pr_opened');
  });
});

describe('resolution/routingContext', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'America/New_York' });
  });
  afterEach(async () => close());

  it('currentLocalTime converts to the org timezone', async () => {
    // 2026-07-19T14:30:00Z is 10:30 EDT (UTC-4 in July)
    const time = await currentLocalTime(db, orgId, new Date('2026-07-19T14:30:00Z'));
    expect(time).toBe('10:30');
  });

  it('falls back to UTC for an unknown org', async () => {
    const time = await currentLocalTime(db, 'nope', new Date('2026-07-19T14:30:00Z'));
    expect(time).toBe('14:30');
  });

  it('recentPushWorthyCount counts PUSH narrations in the trailing 15 minutes', async () => {
    const now = new Date('2026-07-19T12:00:00Z');
    await db.insert(narrations).values([
      {
        id: 'n1',
        orgId,
        projectId: 'loom',
        eventId: 'e1',
        eventType: 'build.failed',
        occurredAt: new Date('2026-07-19T11:55:00Z'),
        path: 'TEMPLATE',
        intendedPath: 'TEMPLATE',
        delivery: 'PUSH',
      },
      {
        id: 'n2',
        orgId,
        projectId: 'loom',
        eventId: 'e2',
        eventType: 'build.failed',
        occurredAt: new Date('2026-07-19T11:30:00Z'), // outside the 15-min window
        path: 'TEMPLATE',
        intendedPath: 'TEMPLATE',
        delivery: 'PUSH',
      },
    ]);
    expect(await recentPushWorthyCount(db, orgId, 'loom', now)).toBe(1);
  });

  it('pairedOutagePushed reflects the most recent runtime.health_failing narration', async () => {
    expect(await pairedOutagePushed(db, orgId, 'loom')).toBe(false);

    await db.insert(narrations).values({
      id: 'n1',
      orgId,
      projectId: 'loom',
      eventId: 'e1',
      eventType: 'runtime.health_failing',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'PUSH',
    });
    expect(await pairedOutagePushed(db, orgId, 'loom')).toBe(true);
  });
});

describe('resolution/connectorEvents', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('records an org-level (project_id null) narration that always pushes', async () => {
    await recordConnectorAuthFailed(db, orgId, 'GitHub', 'github', '999');
    const rows = await db.select().from(narrations);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBeNull();
    expect(rows[0]?.delivery).toBe('PUSH');
    expect(rows[0]?.fragment).toContain('GitHub');
  });
});
