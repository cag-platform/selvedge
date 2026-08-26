import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { openSandboxRun } from '../../src/server/build/metering.js';
import { previewIsActive, projectIsWorking } from '../../src/server/build/reaper.js';
import { renewPreviewLeaseBySlug, setBuild } from '../../src/server/build/store.js';

describe('development preview leases', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const now = new Date('2026-08-26T22:00:00Z');

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sb_1', previewSlug: 'loom-preview' });
  });
  afterEach(async () => close());

  it('counts a live browser preview as active work', async () => {
    const segment = await openSandboxRun(db, 'org_1', 'loom', 'sb_1', now);
    await renewPreviewLeaseBySlug(db, 'loom-preview', new Date(now.getTime() + 10 * 60_000));
    expect(await projectIsWorking(db, {
      id: segment.id, orgId: 'org_1', projectId: 'loom', sandboxId: 'sb_1', startedAt: now, lastAliveAt: now,
    }, now)).toBe(true);
    expect(await previewIsActive(db, {
      id: segment.id, orgId: 'org_1', projectId: 'loom', sandboxId: 'sb_1', startedAt: now, lastAliveAt: now,
    }, now)).toBe(true);
  });

  it('does not keep a sandbox awake after the preview lease expires', async () => {
    const segment = await openSandboxRun(db, 'org_1', 'loom', 'sb_1', now);
    await renewPreviewLeaseBySlug(db, 'loom-preview', new Date(now.getTime() - 1));
    expect(await projectIsWorking(db, {
      id: segment.id, orgId: 'org_1', projectId: 'loom', sandboxId: 'sb_1', startedAt: now, lastAliveAt: now,
    }, now)).toBe(false);
  });
});
