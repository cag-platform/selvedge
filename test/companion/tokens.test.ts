import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { companionTokens, orgs } from '../../src/server/db/schema/index.js';
import {
  issueCompanionToken,
  listCompanionTokens,
  resolveCompanionToken,
  revokeCompanionToken,
  touchCompanionToken,
} from '../../src/server/companion/tokens.js';

/**
 * The key a program on someone's machine carries. Everything here is the
 * beacon's discipline restated, because it is the discipline that matters: the
 * secret exists in one place for one moment, and after that only its hash does.
 */
describe('companion keys', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  it('issues a key that works, and stores only its hash', async () => {
    const { token, id } = await issueCompanionToken(db, 'org_1', 'my laptop');
    expect(token.startsWith('slv_')).toBe(true);
    expect(await resolveCompanionToken(db, token)).toMatchObject({ orgId: 'org_1', id });

    const [row] = await db.select().from(companionTokens).where(eq(companionTokens.id, id));
    // The secret must not be recoverable from the database, by anyone, ever.
    expect(row!.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
  });

  it('refuses everything that is not a live key, and says nothing about which', async () => {
    const { token, id } = await issueCompanionToken(db, 'org_1', 'laptop');
    expect(await resolveCompanionToken(db, 'slv_nonsense')).toBeNull();
    expect(await resolveCompanionToken(db, 'not-even-a-key')).toBeNull();
    expect(await resolveCompanionToken(db, '')).toBeNull();
    expect(await resolveCompanionToken(db, undefined)).toBeNull();

    await revokeCompanionToken(db, 'org_1', id);
    expect(await resolveCompanionToken(db, token)).toBeNull();
  });

  it('keeps a revoked key on the record rather than deleting it', async () => {
    const { id } = await issueCompanionToken(db, 'org_1', 'old laptop');
    expect(await revokeCompanionToken(db, 'org_1', id)).toBe(true);
    const keys = await listCompanionTokens(db, 'org_1');
    expect(keys).toHaveLength(1);
    expect(keys[0]!.revoked_at).not.toBeNull();
    // Revoking twice is not a second event.
    expect(await revokeCompanionToken(db, 'org_1', id)).toBe(false);
  });

  it('is org-scoped: one org can neither see nor revoke another org\'s key', async () => {
    const { id } = await issueCompanionToken(db, 'org_1', 'laptop');
    expect(await listCompanionTokens(db, 'org_2')).toEqual([]);
    expect(await revokeCompanionToken(db, 'org_2', id)).toBe(false);
  });

  it('remembers when a key was last used, and never shows the key itself', async () => {
    const { id } = await issueCompanionToken(db, 'org_1', 'laptop');
    await touchCompanionToken(db, id);
    const [key] = await listCompanionTokens(db, 'org_1');
    expect(key!.last_used_at).not.toBeNull();
    expect(Object.keys(key!)).toEqual(['id', 'name', 'created_at', 'last_used_at', 'revoked_at']);
  });
});
