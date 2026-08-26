import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentRuns, orgs } from '../../src/server/db/schema/index.js';
import { setBuild } from '../../src/server/build/store.js';
import { inspectCheckout } from '../../src/server/build/checkoutGuard.js';

describe('checkout guard', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const test = await createTestDb(); db = test.db; close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('returns a bounded clean plan without provisioning anything', async () => {
    const guard = await inspectCheckout(db, 'org_1', 'loom', { threadId: 'thread_1', goal: ' Fix sign in ', expectedFiles: ['src/auth.ts'] });
    expect(guard.state).toBe('clean');
    expect(guard.safe_to_start).toBe(true);
    expect(guard.plan).toMatchObject({ goal: 'Fix sign in', expected_files: ['src/auth.ts'], expected_duration_minutes: { minimum: 5, maximum: 20 } });
    expect(guard.plan.automatic_stop.after_minutes).toBe(20);
    expect(guard.preview).toEqual({ state: 'not_started', url: null, starts_or_wakes_on_open: true });
    expect(guard.fresh_isolated_checkout.supported).toBe(false);
  });

  it('distinguishes attributable same-thread work from an unattributed dirty checkout', async () => {
    const runId = ulid();
    await db.insert(agentRuns).values({ id: runId, orgId: 'org_1', projectId: 'loom', threadId: 'thread_1', prompt: 'change', status: 'succeeded', changedPaths: ['src/a.ts'] });
    await setBuild(db, 'org_1', 'loom', { stagedChangesReady: true, dirtyRunId: runId, dirtyThreadId: 'thread_1', dirtyAgent: 'codex', dirtyObservedAt: new Date('2026-08-25T12:00:00Z') });
    const own = await inspectCheckout(db, 'org_1', 'loom', { threadId: 'thread_1', goal: 'continue' });
    expect(own.state).toBe('attributable_existing_work');
    expect(own.safe_to_start).toBe(true);
    expect(own.existing_work?.changed_paths).toEqual(['src/a.ts']);

    await setBuild(db, 'org_1', 'loom', { dirtyRunId: null, dirtyThreadId: null, dirtyAgent: null, dirtyObservedAt: null });
    const unknown = await inspectCheckout(db, 'org_1', 'loom', { threadId: 'thread_1', goal: 'continue' });
    expect(unknown.state).toBe('unattributed_dirty');
    expect(unknown.safe_to_start).toBe(false);
  });

  it('gives active mutation ownership precedence over dirty state', async () => {
    const runId = ulid();
    await db.insert(agentRuns).values({ id: runId, orgId: 'org_1', projectId: 'loom', threadId: 'other', agent: 'claude-code', prompt: 'working', status: 'running', startedAt: new Date() });
    const guard = await inspectCheckout(db, 'org_1', 'loom', { threadId: 'thread_1', goal: 'change it' });
    expect(guard.state).toBe('active_mutation');
    expect(guard.ownership).toMatchObject({ run_id: runId, thread_id: 'other', agent: 'claude-code' });
    expect(guard.choices.find((choice) => choice.id === 'wait')?.available).toBe(true);
  });
});
