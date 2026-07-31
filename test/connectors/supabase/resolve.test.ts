import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { connectCredential } from '../../../src/server/connectors/credentials/store.js';
import { resolveSupabaseToken } from '../../../src/server/connectors/supabase/resolve.js';

describe('supabase/resolveSupabaseToken — customer-owned, no managed fallback', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values([{ orgId: 'a' }, { orgId: 'b' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it("returns the org's own Supabase token", async () => {
    await connectCredential(db, 'a', 'supabase', 'org-a-supabase-token');
    expect(await resolveSupabaseToken(db, 'a')).toBe('org-a-supabase-token');
  });

  it('returns null when the org has no token', async () => {
    expect(await resolveSupabaseToken(db, 'a')).toBeNull();
  });

  it("never returns another org's token", async () => {
    await connectCredential(db, 'b', 'supabase', 'org-b-supabase-token');
    expect(await resolveSupabaseToken(db, 'a')).toBeNull();
  });
});
