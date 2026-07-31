import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { connectCredential } from '../../../src/server/connectors/credentials/store.js';
import { resolveRailwayToken } from '../../../src/server/connectors/railway/resolve.js';

describe('railway/resolveRailwayToken — customer-owned, no managed fallback', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    process.env.RAILWAY_API_TOKEN = 'a-platform-token-that-must-NOT-be-used';
    await db.insert(orgs).values([{ orgId: 'a' }, { orgId: 'b' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    delete process.env.RAILWAY_API_TOKEN;
    await close();
  });

  it("returns the org's own Railway token", async () => {
    await connectCredential(db, 'a', 'railway', 'org-a-railway-token');
    expect(await resolveRailwayToken(db, 'a')).toBe('org-a-railway-token');
  });

  it('returns null when the org has no token — never the platform env token', async () => {
    // A host is the customer's or nothing. Unlike fuel, there is no managed
    // fallback: RAILWAY_API_TOKEN in the environment must be ignored.
    expect(await resolveRailwayToken(db, 'a')).toBeNull();
  });

  it("never returns another org's token", async () => {
    await connectCredential(db, 'b', 'railway', 'org-b-railway-token');
    expect(await resolveRailwayToken(db, 'a')).toBeNull();
  });
});
