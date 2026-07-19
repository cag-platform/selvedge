import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { composeDigestForOrg } from '../../src/server/digest/compose.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NewSiltaEvent } from '../../src/shared/types/event.js';

describe('digest/compose (integration)', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
  });

  afterEach(async () => close());

  function ev(overrides: Partial<NewSiltaEvent>): NewSiltaEvent {
    return {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-18T10:00:00Z', // "yesterday" relative to 2026-07-19
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd1',
      ...overrides,
    };
  }

  it('composes a digest from yesterday\'s DIGEST/PUSH narrations and persists it', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    await ingestEvent(db, ev({ event_type: 'build.failed', dedupe_key: 'd1' }));
    await ingestEvent(db, ev({ event_type: 'build.succeeded', dedupe_key: 'd2' }));

    const digest = await composeDigestForOrg(db, orgId, new Date('2026-07-19T12:00:00Z'));
    expect(digest.digestDate).toBe('2026-07-19');
    expect(digest.renderedText).toContain('Loom');
    expect(digest.openThreads).toHaveLength(1); // the build.failed attention item carries forward
  });

  it('is idempotent per org+local-day: composing twice returns the same digest', async () => {
    const first = await composeDigestForOrg(db, orgId, new Date('2026-07-19T12:00:00Z'));
    const second = await composeDigestForOrg(db, orgId, new Date('2026-07-19T13:00:00Z'));
    expect(second.id).toBe(first.id);
  });

  it('closes an open thread from yesterday\'s digest once the project is quiet today', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    // Day 1 (07-18): a failure creates an open thread.
    await ingestEvent(db, ev({ event_type: 'build.failed', occurred_at: '2026-07-17T10:00:00Z', dedupe_key: 'd1' }));
    const day1 = await composeDigestForOrg(db, orgId, new Date('2026-07-18T12:00:00Z'));
    expect(day1.openThreads).toHaveLength(1);

    // Day 2 (07-19): no new events for loom -> yesterday's thread closes.
    const day2 = await composeDigestForOrg(db, orgId, new Date('2026-07-19T12:00:00Z'));
    expect(day2.renderedText).toMatch(/is resolved/);
    expect(day2.openThreads).toHaveLength(0);
  });

  it('renders a quiet-night digest when nothing happened', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'mirror', name: 'Mirror', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: false, touches_money: false },
    });
    await createPack(db, orgId, pack);

    // Monday, not Sunday — isolates the quiet-day headline from the G3
    // weekly retrospective, which intentionally takes over on Sundays even
    // on an otherwise quiet day (digest-composer §6).
    const digest = await composeDigestForOrg(db, orgId, new Date('2026-07-20T12:00:00Z'));
    expect(digest.renderedText).toMatch(/quiet night/i);
  });

  it('the weekly retrospective takes over the quiet-day headline on Sundays', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'mirror', name: 'Mirror', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: false, touches_money: false },
    });
    await createPack(db, orgId, pack);

    const digest = await composeDigestForOrg(db, orgId, new Date('2026-07-19T12:00:00Z')); // a Sunday
    expect(digest.renderedText).toMatch(/This week/);
  });
});
