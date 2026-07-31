import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, events as eventsTable } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { pollHealth, newMonitorState } from '../../src/server/monitor/poller.js';
import {
  makePollerIngest,
  listHealthChecksToPoll,
  insertHealthCheck,
  disableHealthCheck,
} from '../../src/server/monitor/wiring.js';
import type { ProbeResult } from '../../src/server/monitor/probe.js';

const down: ProbeResult = { up: false, latencyMs: 0, detail: 'the page returned 500' };

describe('monitor wiring — a DB check becomes a real ingested event', () => {
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
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'a shop' },
        stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  it('discovers an enabled check, resolves its app source, and skips a disabled one', async () => {
    await insertHealthCheck(db, { id: 'c1', orgId, projectId: 'loom', kind: 'http', url: 'https://loom.example' });
    await insertHealthCheck(db, { id: 'c2', orgId, projectId: 'loom', kind: 'http', url: 'https://x' });
    await disableHealthCheck(db, orgId, 'c2');

    const checks = await listHealthChecksToPoll(db);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.spec.id).toBe('c1');
    expect(checks[0]!.projectId).toBe('loom');
    expect(checks[0]!.sourceAccountId).toBe('acme/loom'); // from the pack's github source
  });

  it('two failing ticks ingest a runtime.health_failing event against the right project', async () => {
    await insertHealthCheck(db, { id: 'c1', orgId, projectId: 'loom', kind: 'http', url: 'https://loom.example' });

    const state = newMonitorState();
    const ingest = makePollerIngest(db);
    let clock = 1_000_000;
    const runTick = () =>
      pollHealth({
        db,
        state,
        now: () => new Date((clock += 60_000)),
        listChecks: () => listHealthChecksToPoll(db),
        probe: async () => down,
        ingest,
      });

    await runTick(); // first failure — silent
    await runTick(); // second — announced and ingested

    const rows = await db.select().from(eventsTable).where(eq(eventsTable.orgId, orgId));
    const failing = rows.filter((r) => r.eventType === 'runtime.health_failing');
    expect(failing).toHaveLength(1);
    expect(failing[0]!.projectId).toBe('loom'); // placed against the right project, no source resolution
  });

  it('does not ingest anything for a single blip', async () => {
    await insertHealthCheck(db, { id: 'c1', orgId, projectId: 'loom', kind: 'http', url: 'https://loom.example' });
    const state = newMonitorState();
    let clock = 1_000_000;
    await pollHealth({
      db,
      state,
      now: () => new Date((clock += 60_000)),
      listChecks: () => listHealthChecksToPoll(db),
      probe: async () => down, // one failure only
      ingest: makePollerIngest(db),
    });
    const rows = await db.select().from(eventsTable).where(eq(eventsTable.orgId, orgId));
    expect(rows.filter((r) => r.eventType === 'runtime.health_failing')).toHaveLength(0);
  });
});
