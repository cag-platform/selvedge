import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import {
  createPack,
  deletePack,
  getPack,
  listPacks,
  setPackMuted,
  mutedProjectIds,
  archivedProjectIds,
} from '../../src/server/packs/store.js';
import { resolveProjectId } from '../../src/server/resolution/resolveProject.js';
import { gatherPacks } from '../../src/server/digest/gather.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { orgs, narrations, events } from '../../src/server/db/schema/index.js';

describe('packs/store — permanent delete (archive tombstone)', () => {
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

  it('hides a deleted project from every user surface', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);

    expect(await deletePack(db, orgId, pack.identity.project_id)).toBe(true);

    // Gone from the reads the client sees…
    expect(await getPack(db, orgId, pack.identity.project_id)).toBeNull();
    expect(await listPacks(db, orgId)).toHaveLength(0);
    // …but the row survives as a tombstone.
    expect(await archivedProjectIds(db, orgId)).toEqual(new Set([pack.identity.project_id]));
    expect(await getPack(db, orgId, pack.identity.project_id, { includeArchived: true })).not.toBeNull();
  });

  it('does NOT let the GitHub connector resurrect a deleted project', async () => {
    // Fixture maps github repo acme/test-project → the pack.
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    await deletePack(db, orgId, pack.identity.project_id);

    // The backfill uses resolveProjectId to decide whether a repo is
    // spoken-for. A deleted project must still resolve so the repo is NOT
    // re-scaffolded into a fresh pack.
    const resolved = await resolveProjectId(db, orgId, 'github', 'acme/test-project');
    expect(resolved).toBe(pack.identity.project_id);
  });

  it('purges the project’s narrations and events on delete', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    await db.insert(events).values({
      id: 'evt1',
      orgId,
      source: 'github',
      sourceAccountId: 'acct1',
      projectId: pack.identity.project_id,
      eventType: 'push',
      occurredAt: new Date(),
      severityHint: 'info',
      raw: {},
      dedupeKey: 'dk1',
    } as any);

    await deletePack(db, orgId, pack.identity.project_id);

    const remainingEvents = await db.select().from(events);
    expect(remainingEvents).toHaveLength(0);
    const remainingNarrations = await db.select().from(narrations);
    expect(remainingNarrations).toHaveLength(0);
  });

  it('returns false when deleting a missing or already-deleted project', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    expect(await deletePack(db, orgId, 'no-such-project')).toBe(false);
    expect(await deletePack(db, orgId, pack.identity.project_id)).toBe(true);
    // Second delete: already archived → false (the route maps this to a 404).
    expect(await deletePack(db, orgId, pack.identity.project_id)).toBe(false);
  });
});

describe('packs/store — mute (deprioritize)', () => {
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

  it('keeps a muted project listed but drops it from the digest', async () => {
    const kept = makeTestPack({ identity: { project_id: 'kept', name: 'Kept', owner_description: 'x' } });
    const muted = makeTestPack({ identity: { project_id: 'muted', name: 'Muted', owner_description: 'y' } });
    await createPack(db, orgId, kept);
    await createPack(db, orgId, muted);

    expect(await setPackMuted(db, orgId, 'muted', true)).toBe(true);

    // Still visible in the Projects list…
    const listed = await listPacks(db, orgId);
    expect(listed.map((p) => p.identity.project_id).sort()).toEqual(['kept', 'muted']);
    expect(await mutedProjectIds(db, orgId)).toEqual(new Set(['muted']));

    // …but excluded from the daily brief.
    const forDigest = await gatherPacks(db, orgId);
    expect(forDigest.map((p) => p.identity.project_id)).toEqual(['kept']);
  });

  it('unmutes reversibly', async () => {
    const pack = makeTestPack();
    await createPack(db, orgId, pack);
    await setPackMuted(db, orgId, pack.identity.project_id, true);
    expect(await mutedProjectIds(db, orgId)).toEqual(new Set([pack.identity.project_id]));

    expect(await setPackMuted(db, orgId, pack.identity.project_id, false)).toBe(true);
    expect(await mutedProjectIds(db, orgId)).toEqual(new Set());
    expect((await gatherPacks(db, orgId)).map((p) => p.identity.project_id)).toEqual([pack.identity.project_id]);
  });

  it('returns false when muting a missing project', async () => {
    expect(await setPackMuted(db, orgId, 'nope', true)).toBe(false);
  });
});
