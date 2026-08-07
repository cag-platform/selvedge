import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, events as eventsTable, healthChecks } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { pollHealth, newMonitorState } from '../../src/server/monitor/poller.js';
import {
  makePollerIngest,
  listHealthChecksToPoll,
  insertHealthCheck,
  disableHealthCheck,
  ensureLiveUrlCheck,
  liveUrlCheckId,
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

  it('drops a check whose kind it does not recognise rather than probing it as something else', async () => {
    // `kind` is free text, so a row from another deploy can carry anything.
    // Probing an unknown kind as HTTP would yield a confident, wrong up/down.
    await db.insert(healthChecks).values({ id: 'c_odd', orgId, projectId: 'loom', kind: 'carrier-pigeon', url: 'https://x' });
    await insertHealthCheck(db, { id: 'c_ok', orgId, projectId: 'loom', kind: 'http', url: 'https://loom.example' });

    const toPoll = await listHealthChecksToPoll(db);
    expect(toPoll.map((c) => c.spec.id)).toEqual(['c_ok']);
  });
});

describe('ensureLiveUrlCheck — arming the watch is idempotent', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'a shop' } }));
  });
  afterEach(async () => close());

  it('arms once however many times it is called', async () => {
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://loom.example');
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://loom.example');
    expect(await listHealthChecksToPoll(db)).toHaveLength(1);
  });

  it('follows the address when the app moves, instead of watching the old one', async () => {
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://old.example');
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://new.example');
    const checks = await listHealthChecksToPoll(db);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.spec.url).toBe('https://new.example');
  });

  it('re-enables a previously disabled check — going live again is a request to be watched', async () => {
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://loom.example');
    await disableHealthCheck(db, orgId, liveUrlCheckId(orgId, 'loom'));
    expect(await listHealthChecksToPoll(db)).toHaveLength(0);

    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://loom.example');
    expect(await listHealthChecksToPoll(db)).toHaveLength(1);
  });

  it('keeps one org’s watch out of another’s', async () => {
    await db.insert(orgs).values({ orgId: 'org_2' });
    await createPack(db, 'org_2', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
    await ensureLiveUrlCheck(db, orgId, 'loom', 'https://one.example');
    await ensureLiveUrlCheck(db, 'org_2', 'loom', 'https://two.example');

    const checks = await listHealthChecksToPoll(db);
    expect(checks).toHaveLength(2);
    expect(new Set(checks.map((c) => c.orgId))).toEqual(new Set([orgId, 'org_2']));
  });
});
