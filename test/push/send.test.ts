import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, devices } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { runDigestSchedule } from '../../src/server/digest/schedule.js';
import { sendToOrgDevices } from '../../src/server/push/send.js';
import { FakePushSender } from '../../src/server/push/fake.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('push/sendToOrgDevices', () => {
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

  it('sends to every device and prunes the ones APNs reports unregistered', async () => {
    await db.insert(devices).values([
      { orgId, token: 'live', platform: 'ios', environment: 'production' },
      { orgId, token: 'dead', platform: 'ios', environment: 'sandbox' },
    ]);
    const fake = new FakePushSender(['dead']);

    const summary = await sendToOrgDevices(db, orgId, fake, { title: 'T', body: 'B' });

    expect(fake.sent).toHaveLength(2);
    expect(summary.sent).toBe(1);
    expect(summary.pruned).toBe(1);
    const remaining = await db.select().from(devices).where(eq(devices.orgId, orgId));
    expect(remaining.map((r) => r.token)).toEqual(['live']);
  });
});

describe('push — morning brief via scheduler', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const at7amUtc = new Date('2026-07-20T07:30:00Z');

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
    await db.insert(devices).values({ orgId, token: 'tok', platform: 'ios', environment: 'production' });
  });
  afterEach(async () => close());

  it('pushes the brief once when it is first composed, and not on a recompose tick', async () => {
    const fake = new FakePushSender();

    await runDigestSchedule(db, at7amUtc, undefined, fake);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.notification.title).toMatch(/morning brief/i);

    // A later tick in the same 7:00 hour recomposes-idempotently → no 2nd push.
    await runDigestSchedule(db, new Date('2026-07-20T07:45:00Z'), undefined, fake);
    expect(fake.sent).toHaveLength(1);
  });

  it('does not push when no sender is configured', async () => {
    const composed = await runDigestSchedule(db, at7amUtc, undefined, undefined);
    expect(composed).toContain(orgId);
  });
});

describe('push — immediate critical push on a PUSH-routed narration', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await db.insert(devices).values({ orgId, token: 'tok', platform: 'ios', environment: 'production' });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'everything' } },
      }),
    );
  });
  afterEach(async () => close());

  it('sends when a live-critical event routes to PUSH', async () => {
    const fake = new FakePushSender();
    const result = await ingestEvent(
      db,
      {
        org_id: orgId,
        source: 'github',
        source_account_id: 'acme/test-project',
        event_type: 'build.slow',
        occurred_at: '2026-07-20T10:00:00Z',
        severity_hint: 'warn',
        raw: {},
        dedupe_key: 'crit-1',
      },
      undefined,
      fake,
    );

    expect(result.delivery).toBe('PUSH');
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.notification.interruptionLevel).toBe('time-sensitive');
  });
});
