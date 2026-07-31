import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import {
  connectCredential,
  listConnected,
  useCredential,
  markInvalid,
  revokeCredential,
} from '../../../src/server/connectors/credentials/store.js';

describe('credentials/store', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_a';
  const SECRET = 'sk-ant-api03-abcdefghijklmnop-a03f';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_b' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it('connects a credential and uses it, but never exposes it in the listing', async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET, { kind: 'api_key', label: 'My Claude key' });

    const listed = await listConnected(db, orgId);
    expect(listed).toHaveLength(1);
    const row = listed[0]!;
    expect(row.provider).toBe('anthropic');
    expect(row.label).toBe('My Claude key');
    expect(row.last4).toBe('a03f');
    // The load-bearing property: nothing in the display row can reconstruct
    // the secret. Serialise the whole thing and prove the token isn't in it.
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(JSON.stringify(listed)).not.toContain('abcdefgh');

    // The one path that returns plaintext returns the real secret.
    expect(await useCredential(db, orgId, 'anthropic')).toBe(SECRET);
  });

  it('re-connecting replaces the secret rather than adding a row', async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET);
    await connectCredential(db, orgId, 'anthropic', 'sk-ant-api03-second-key-9999');
    const listed = await listConnected(db, orgId);
    expect(listed).toHaveLength(1);
    expect(await useCredential(db, orgId, 'anthropic')).toBe('sk-ant-api03-second-key-9999');
  });

  it('stamps last_used_at only when the credential is actually used', async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET);
    expect((await listConnected(db, orgId))[0]!.lastUsedAt).toBeNull();
    await useCredential(db, orgId, 'anthropic');
    expect((await listConnected(db, orgId))[0]!.lastUsedAt).not.toBeNull();
  });

  it("one org cannot use another org's credential", async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET);
    // org_b has no row → null; and even a leaked ciphertext wouldn't decrypt
    // under org_b's key (proven in crypto.test.ts).
    expect(await useCredential(db, 'org_b', 'anthropic')).toBeNull();
  });

  it('marks invalid without deleting, so the brief can explain it', async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET);
    await markInvalid(db, orgId, 'anthropic');
    const row = (await listConnected(db, orgId))[0]!;
    expect(row.status).toBe('invalid');
    // Still present, still usable if the customer wants to retry — invalid is
    // a signal, not a deletion.
    expect(await useCredential(db, orgId, 'anthropic')).toBe(SECRET);
  });

  it('revoke deletes the row entirely — the ciphertext does not linger', async () => {
    await connectCredential(db, orgId, 'anthropic', SECRET);
    expect(await revokeCredential(db, orgId, 'anthropic')).toBe(true);
    expect(await listConnected(db, orgId)).toHaveLength(0);
    expect(await useCredential(db, orgId, 'anthropic')).toBeNull();
    // Revoking something already gone is a no-op, not an error.
    expect(await revokeCredential(db, orgId, 'anthropic')).toBe(false);
  });

  it('returns null (not throw) when no credential is configured', async () => {
    expect(await useCredential(db, orgId, 'anthropic')).toBeNull();
  });
});
