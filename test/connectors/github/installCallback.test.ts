import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { markInstalled, orgForInstallation } from '../../../src/server/connectors/github/health.js';

/**
 * GitHub's "Save"/re-configure redirect to the Setup URL carries
 * installation_id but no `state` — the callback resolves the org from the
 * registration made on first install instead of rejecting the request.
 */
describe('install callback org resolution', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('finds the org that registered an installation', async () => {
    await markInstalled(db, 'org_1', '4242', 'acme');
    expect(await orgForInstallation(db, '4242')).toBe('org_1');
  });

  it('returns null for an unknown installation', async () => {
    expect(await orgForInstallation(db, '9999')).toBeNull();
  });
});
