import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import {
  issueBeacon,
  resolveBeacon,
  revokeBeacon,
  beaconStatus,
  loadErrorState,
  saveErrorState,
} from '../../../src/server/connectors/errors/beaconStore.js';
import { FRESH } from '../../../src/server/monitor/errorRate.js';

describe('error beacon store — a token shown once, stored only as a hash', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_a' }, { orgId: 'org_b' }]);
  });
  afterEach(async () => close());

  it('issues a token that resolves back to its org and project', async () => {
    const token = await issueBeacon(db, 'org_a', 'loom');
    expect(token).toMatch(/^sbk_/);
    expect(await resolveBeacon(db, token)).toEqual({ orgId: 'org_a', projectId: 'loom' });
  });

  it('rotating invalidates the previous token', async () => {
    const first = await issueBeacon(db, 'org_a', 'loom');
    const second = await issueBeacon(db, 'org_a', 'loom');
    expect(second).not.toBe(first);
    expect(await resolveBeacon(db, first)).toBeNull(); // old token no longer works
    expect(await resolveBeacon(db, second)).toEqual({ orgId: 'org_a', projectId: 'loom' });
  });

  it('a garbage or foreign token resolves to nothing', async () => {
    await issueBeacon(db, 'org_a', 'loom');
    expect(await resolveBeacon(db, 'sbk_not_a_real_token')).toBeNull();
    expect(await resolveBeacon(db, 'no-prefix')).toBeNull();
  });

  it('revoke stops the token working immediately', async () => {
    const token = await issueBeacon(db, 'org_a', 'loom');
    expect(await revokeBeacon(db, 'org_a', 'loom')).toBe(true);
    expect(await resolveBeacon(db, token)).toBeNull();
  });

  it('status reports issuance without ever exposing a token', async () => {
    expect((await beaconStatus(db, 'org_a', 'loom')).issued).toBe(false);
    await issueBeacon(db, 'org_a', 'loom');
    const status = await beaconStatus(db, 'org_a', 'loom');
    expect(status.issued).toBe(true);
    expect(status).not.toHaveProperty('token');
  });

  it('detector state round-trips, defaulting to FRESH when unseen', async () => {
    expect(await loadErrorState(db, 'org_a', 'loom', 'default')).toEqual(FRESH);
    await saveErrorState(db, 'org_a', 'loom', 'default', { baseline: 0.02, windowsSeen: 6, consecutiveElevated: 1, alerted: false });
    expect(await loadErrorState(db, 'org_a', 'loom', 'default')).toEqual({
      baseline: 0.02,
      windowsSeen: 6,
      consecutiveElevated: 1,
      alerted: false,
    });
  });

  it('detector state is isolated per org, project, and source', async () => {
    await saveErrorState(db, 'org_a', 'loom', 'default', { baseline: 0.5, windowsSeen: 9, consecutiveElevated: 0, alerted: true });
    expect(await loadErrorState(db, 'org_b', 'loom', 'default')).toEqual(FRESH); // other org
    expect(await loadErrorState(db, 'org_a', 'other', 'default')).toEqual(FRESH); // other project
    expect(await loadErrorState(db, 'org_a', 'loom', 'api')).toEqual(FRESH); // other source
  });
});
