import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { assignUnsortedSource, listUnsortedEvents } from '../../src/server/resolution/unsortedTray.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('resolution/unsortedTray', () => {
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

  it('assigning a source resolves existing unsorted events and writes the mapping into the pack topology', async () => {
    const pack = makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' }, topology: { sources: [] } });
    await createPack(db, orgId, pack);

    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd1',
    });

    let tray = await listUnsortedEvents(db, orgId);
    expect(tray).toHaveLength(1);

    const { updatedCount } = await assignUnsortedSource(db, orgId, 'github', 'acme/loom', 'loom');
    expect(updatedCount).toBe(1);

    tray = await listUnsortedEvents(db, orgId);
    expect(tray).toHaveLength(0);

    const updatedPack = await getPack(db, orgId, 'loom');
    expect(updatedPack?.topology.sources).toEqual([{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }]);
  });

  it('future events from the same source auto-resolve after assignment (never asks twice)', async () => {
    const pack = makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' }, topology: { sources: [] } });
    await createPack(db, orgId, pack);

    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd1',
    });
    await assignUnsortedSource(db, orgId, 'github', 'acme/loom', 'loom');

    const second = await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: '2026-07-20T10:00:00Z',
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd2',
    });
    expect(second.projectId).toBe('loom');
  });
});
