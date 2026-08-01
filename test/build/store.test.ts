import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { getBuild, setBuild, clearSandbox } from '../../src/server/build/store.js';

describe('build store — the workshop state, org-scoped', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('upserts and reads back build state', async () => {
    expect(await getBuild(db, 'org_1', 'loom')).toBeNull();
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sbx_1', repoFullName: 'acme/loom', claudeSessionId: 'sess_1' });
    const b = await getBuild(db, 'org_1', 'loom');
    expect(b?.sandboxId).toBe('sbx_1');
    expect(b?.repoFullName).toBe('acme/loom');
    expect(b?.branch).toBe('main'); // default
  });

  it('touches only the given fields on update', async () => {
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sbx_1', repoFullName: 'acme/loom' });
    await setBuild(db, 'org_1', 'loom', { stagedChangesReady: true });
    const b = await getBuild(db, 'org_1', 'loom');
    expect(b?.stagedChangesReady).toBe(true);
    expect(b?.sandboxId).toBe('sbx_1'); // unchanged
  });

  it('clearSandbox detaches the sandbox and wipes session + preview + staged flag', async () => {
    await setBuild(db, 'org_1', 'loom', {
      sandboxId: 'sbx_1', claudeSessionId: 'sess_1', stagedChangesReady: true, previewUrl: 'https://x', repoFullName: 'acme/loom',
    });
    await clearSandbox(db, 'org_1', 'loom');
    const b = await getBuild(db, 'org_1', 'loom');
    expect(b?.sandboxId).toBeNull();
    expect(b?.claudeSessionId).toBeNull();
    expect(b?.stagedChangesReady).toBe(false);
    expect(b?.previewUrl).toBeNull();
    expect(b?.repoFullName).toBe('acme/loom'); // repo identity kept — only the live sandbox is gone
  });

  it('is org-scoped: one org never sees another\'s build state', async () => {
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sbx_1' });
    expect(await getBuild(db, 'org_2', 'loom')).toBeNull();
  });
});
