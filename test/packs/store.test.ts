import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { createPack, getPack, listPacks, updateHumanSections, updateMachineSections } from '../../src/server/packs/store.js';
import { PackValidationError } from '../../src/server/packs/validate.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { orgs } from '../../src/server/db/schema/index.js';

describe('packs/store', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_a';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });

  afterEach(async () => {
    await close();
  });

  it('creates and fetches a pack', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    const fetched = await getPack(db, orgId, pack.identity.project_id);
    expect(fetched?.identity.name).toBe(pack.identity.name);
  });

  it('returns null for a missing pack', async () => {
    expect(await getPack(db, orgId, 'nope')).toBeNull();
  });

  it('lists all packs for an org', async () => {
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'p1', name: 'P1', owner_description: 'x' } }));
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'p2', name: 'P2', owner_description: 'y' } }));
    const list = await listPacks(db, orgId);
    expect(list).toHaveLength(2);
  });

  it('rejects creating an invalid pack and writes nothing', async () => {
    const bad: any = makeTestPack();
    bad.stakes.tier = 'not_a_tier';
    await expect(createPack(db, orgId, bad)).rejects.toThrow(PackValidationError);
    expect(await getPack(db, orgId, bad.identity.project_id)).toBeNull();
  });

  it('updateHumanSections merges and persists', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    const updated = await updateHumanSections(db, orgId, pack.identity.project_id, { identity: { name: 'New Name' } as any });
    expect(updated.identity.name).toBe('New Name');
    expect((await getPack(db, orgId, pack.identity.project_id))?.identity.name).toBe('New Name');
  });

  it('updateHumanSections rejects a patch that produces an invalid pack', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    await expect(
      updateHumanSections(db, orgId, pack.identity.project_id, { voice: { detail_level: 'bogus' } as any }),
    ).rejects.toThrow(PackValidationError);
  });

  it('updateMachineSections additively appends a source and persists', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    const updated = await updateMachineSections(db, orgId, pack.identity.project_id, {
      addSources: [{ connector: 'neon', resource_id: 'db-1', role: 'database' }],
    });
    expect(updated.topology.sources).toHaveLength(2);
    const persisted = await getPack(db, orgId, pack.identity.project_id);
    expect(persisted?.topology.sources).toHaveLength(2);
  });

  it('throws when updating a pack that does not exist', async () => {
    await expect(updateHumanSections(db, orgId, 'ghost', { identity: { name: 'x' } as any })).rejects.toThrow(/No pack/);
  });
});
