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
  return (await useCredentialWithKind(db, orgId, provider))?.secret ?? null;
}

/** A used credential, and what sort of thing it is. */
export type UsedCredential = { secret: string; kind: CredentialKind };

/**
 * Is there a usable credential here, and what sort — WITHOUT decrypting it.
 *
 * For the surfaces that need to know whether something could run rather than
 * to run it: the agent roster, an availability check, a settings screen. Going
 * through `useCredential` for those would stamp `last_used_at` on a credential
 * nothing used, which turns a genuinely useful column ("when did this key last
 * do any work?") into a record of how often somebody opened a page.
 */
export async function credentialPresence(
  db: Db,
  orgId: string,
  provider: string,
): Promise<{ kind: CredentialKind; status: string } | null> {
  const [row] = await db
    .select({ kind: connectorCredentials.kind, status: connectorCredentials.status })
    .from(connectorCredentials)
    .where(and(eq(connectorCredentials.orgId, orgId), eq(connectorCredentials.provider, provider)))
    .limit(1);
  if (!row || row.status === 'revoked') return null;
  return { kind: row.kind === 'subscription' ? 'subscription' : 'api_key', status: row.status };
}

/**
 * The same single decryption path, with the KIND attached.
 *
 * The kind is not decoration. A CLI that can authenticate either way needs to
 * be told which env var to read the secret from, and an API key handed to the
 * subscription variable does not fail loudly — it fails as an auth error deep
 * inside a sandbox the owner has already been charged a minute for. So the
 * caller that hands a secret to a program gets to see what it is holding.
 *
 * A row whose kind predates this distinction reads as 'api_key', which is what
 * the column already defaults to and what every pasted key has been.
 */
export async function useCredentialWithKind(db: Db, orgId: string, provider: string): Promise<UsedCredential | null> {
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
    return { secret, kind: row.kind === 'subscription' ? 'subscription' : 'api_key' };
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
