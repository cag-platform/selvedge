import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { ingestEvent, ingestResolvedEvent } from '../../src/server/resolution/ingest.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NewSelvedgeEvent } from '../../src/shared/types/event.js';

describe('resolution/ingest', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });

  afterEach(async () => {
    await close();
  });

  function pushEvent(overrides: Partial<NewSelvedgeEvent> = {}): NewSelvedgeEvent {
    return {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'dedupe-1',
      ...overrides,
    };
  }

  it('lands an event with no matching pack in the unsorted tray', async () => {
    const result = await ingestEvent(db, pushEvent());
    expect(result.duplicate).toBe(false);
    expect(result.projectId).toBeNull();
    expect(result.delivery).toBeNull();
  });

  it('resolves, routes, and narrates an event against a matching pack', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    const result = await ingestEvent(db, pushEvent());
    expect(result.projectId).toBe('loom');
    expect(result.routeRowId).toBe('A3');
    expect(result.delivery).toBe('DIGEST');
  });

  it('is idempotent: a duplicate delivery (same dedupe_key + occurred_at) does not double-ingest', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    const first = await ingestEvent(db, pushEvent());
    const second = await ingestEvent(db, pushEvent());

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('updates pack state.serving_now and last_successful_deploy on build.succeeded', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    await ingestEvent(db, pushEvent({ event_type: 'build.succeeded', dedupe_key: 'dedupe-2' }));

    const updated = await getPack(db, orgId, 'loom');
    expect(updated?.state?.serving_now?.healthy).toBe(true);
    expect(updated?.state?.last_successful_deploy).toBeTruthy();
  });

  it('refines deploy.failed_previous_serving to deploy.failed_nothing_serving when nothing has ever served', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    const result = await ingestEvent(
      db,
      pushEvent({ event_type: 'deploy.failed_previous_serving', dedupe_key: 'dedupe-3' }),
    );
    expect(result.routeRowId).toBe('B7');
  });

  it('keeps deploy.failed_previous_serving as B6 when the pack shows a prior deploy', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      state: { serving_now: { deployed_at: '2026-07-01T00:00:00Z', healthy: true } },
    });
    await createPack(db, orgId, pack);

    const result = await ingestEvent(
      db,
      pushEvent({ event_type: 'deploy.failed_previous_serving', dedupe_key: 'dedupe-4' }),
    );
    expect(result.routeRowId).toBe('B6');
  });

  it('upgrades build.failed to build.failed_known_flaky when the workflow name matches a known_flaky pattern', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      baselines: { known_flaky: [{ pattern: 'e2e' }] },
    });
    await createPack(db, orgId, pack);

    const result = await ingestEvent(
      db,
      pushEvent({
        event_type: 'build.failed',
        dedupe_key: 'dedupe-5',
        raw: { workflow_run: { name: 'E2E Tests' } },
      }),
    );
    expect(result.routeRowId).toBe('B5');
  });

  it('ingestResolvedEvent skips project resolution and refinement', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    const result = await ingestResolvedEvent(db, 'loom', pushEvent({ event_type: 'code.branch_stalled', dedupe_key: 'stall-1' }));
    expect(result.projectId).toBe('loom');
    expect(result.routeRowId).toBe('A5');
  });

  it('a break narration carries the change→break correlation for a change that landed just before it', async () => {
    const { narrations } = await import('../../src/server/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    // A change lands, then a break twenty minutes later on the same project.
    await ingestEvent(db, pushEvent({ event_type: 'code.commits_landed_default', occurred_at: '2026-07-19T10:00:00Z', dedupe_key: 'chg-1' }));
    await ingestEvent(db, pushEvent({ event_type: 'runtime.health_failing', occurred_at: '2026-07-19T10:20:00Z', severity_hint: 'error', dedupe_key: 'brk-1' }));

    const rows = await db.select().from(narrations).where(eq(narrations.eventType, 'runtime.health_failing'));
    expect(rows).toHaveLength(1);
    const correlation = (rows[0]!.meta as { correlation?: { changeType: string; minutesBefore: number; plain: string } }).correlation;
    expect(correlation).toBeTruthy();
    expect(correlation!.changeType).toBe('code.commits_landed_default');
    expect(correlation!.minutesBefore).toBe(20);
    expect(correlation!.plain).toMatch(/worth checking first/i);
  });

  it('a break narration carries no correlation when nothing shipped in the window', async () => {
    const { narrations } = await import('../../src/server/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);

    // A break with no preceding change — no fabricated culprit.
    await ingestEvent(db, pushEvent({ event_type: 'runtime.health_failing', occurred_at: '2026-07-19T10:20:00Z', severity_hint: 'error', dedupe_key: 'brk-2' }));

    const rows = await db.select().from(narrations).where(eq(narrations.eventType, 'runtime.health_failing'));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.meta as { correlation?: unknown }).correlation).toBeUndefined();
  });
});
