import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { connectorCredentials } from '../../db/schema/index.js';
import { encryptCredential, decryptCredential } from './crypto.js';

/**
 * The credentials store. The one rule the type system can't enforce but this
 * module must: the decrypted secret leaves here through exactly ONE function
 * (`useCredential`), and never through any listing or display path. Everything
 * a UI needs — which provider, which kind, the last four characters, the
 * status — is returned by `listConnected` WITHOUT decrypting anything.
 *
 * Revocation is a single row delete. There is no soft-delete, no tombstone
 * holding the ciphertext: a revoked credential is gone, and re-connecting is
 * the recovery path. That is the honest version of the write-only vault.
 */

export type CredentialKind = 'subscription' | 'api_key';

export type ConnectedCredential = {
  provider: string;
  kind: string;
  label: string | null;
  last4: string | null;
  status: string;
  lastUsedAt: Date | null;
  updatedAt: Date;
};

/** Last four characters, for display only. Short secrets are masked entirely. */
function last4Of(secret: string): string {
  return secret.length >= 8 ? secret.slice(-4) : '';
}

/**
 * Connect (or replace) a credential for a provider. Upsert on (org, provider):
 * re-connecting a provider overwrites the old secret rather than accumulating
 * rows, and resets status to active. The plaintext is encrypted before it ever
 * touches the database and is not returned.
 */
export async function connectCredential(
  db: Db,
  orgId: string,
  provider: string,
  secret: string,
  opts: { kind?: CredentialKind; label?: string } = {},
): Promise<ConnectedCredential> {
  const valueEnc = encryptCredential(orgId, provider, secret);
  const kind = opts.kind ?? 'api_key';
  const label = opts.label ?? null;
  const last4 = last4Of(secret);
  const now = new Date();

  await db
    .insert(connectorCredentials)
    .values({ orgId, provider, kind, valueEnc, label, last4, status: 'active', updatedAt: now })
    .onConflictDoUpdate({
      target: [connectorCredentials.orgId, connectorCredentials.provider],
      set: { valueEnc, kind, label, last4, status: 'active', updatedAt: now, lastUsedAt: null },
    });

  return { provider, kind, label, last4, status: 'active', lastUsedAt: null, updatedAt: now };
}

/** The display list. Never decrypts. Safe to return to a client. */
export async function listConnected(db: Db, orgId: string): Promise<ConnectedCredential[]> {
  const rows = await db
    .select({
      provider: connectorCredentials.provider,
      kind: connectorCredentials.kind,
      label: connectorCredentials.label,
      last4: connectorCredentials.last4,
      status: connectorCredentials.status,
      lastUsedAt: connectorCredentials.lastUsedAt,
      updatedAt: connectorCredentials.updatedAt,
    })
    .from(connectorCredentials)
    .where(eq(connectorCredentials.orgId, orgId))
    .orderBy(connectorCredentials.provider);
  return rows;
}

/**
 * The ONLY decryption path. Returns the plaintext secret for immediate use
 * (a model call, a host API call) and stamps last_used_at. Returns null rather
 * than throwing when there is no active credential, so callers degrade to
 * "not configured" — the same graceful shape as the rest of the product. A
 * credential that fails to decrypt (wrong key, tampered, relabelled) is
 * treated as unusable, not as an exception to bubble up.
 */
export async function useCredential(db: Db, orgId: string, provider: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(connectorCredentials)
    .where(and(eq(connectorCredentials.orgId, orgId), eq(connectorCredentials.provider, provider)))
    .limit(1);
  if (!row || row.status === 'revoked') return null;

  try {
    const secret = decryptCredential(orgId, provider, row.valueEnc);
    await db
      .update(connectorCredentials)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(connectorCredentials.orgId, orgId), eq(connectorCredentials.provider, provider)));
    return secret;
  } catch {
    return null;
  }
}

/**
 * Mark a credential invalid after a provider rejected it (e.g. a 401 from the
 * model API). The brief reads this to say "your Claude connection stopped
 * working" in plain words. Does not delete — the customer reconnects.
 */
export async function markInvalid(db: Db, orgId: string, provider: string): Promise<void> {
  await db
    .update(connectorCredentials)
    .set({ status: 'invalid', updatedAt: new Date() })
    .where(and(eq(connectorCredentials.orgId, orgId), eq(connectorCredentials.provider, provider)));
}

/** Revoke = delete. One row, gone. The ciphertext does not linger. */
export async function revokeCredential(db: Db, orgId: string, provider: string): Promise<boolean> {
  const deleted = await db
    .delete(connectorCredentials)
    .where(and(eq(connectorCredentials.orgId, orgId), eq(connectorCredentials.provider, provider)))
    .returning({ provider: connectorCredentials.provider });
  return deleted.length > 0;
}
