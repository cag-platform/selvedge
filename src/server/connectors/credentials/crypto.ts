import crypto from 'node:crypto';

/**
 * Encryption for connector credentials (host tokens, database OAuth tokens,
 * model/fuel keys) — the most valuable rows in the database.
 *
 * Three deliberate departures from the toile implementation this descends
 * from, each fixing a known defect:
 *
 * 1. **Dedicated key root.** Toile derived from SESSION_SECRET, so rotating
 *    session signing silently made every stored secret undecryptable (and
 *    vice versa — you couldn't rotate one without the other). Credentials
 *    here are keyed from CREDENTIALS_KEY and nothing else. Rotating Clerk,
 *    sessions, or webhooks never touches stored credentials.
 *
 * 2. **Per-org key derivation.** The org id is part of the scrypt salt, so
 *    every org's rows are encrypted under a different key. A bug that serves
 *    the wrong org's row returns ciphertext the caller cannot decrypt —
 *    tenancy enforced by cryptography, not only by WHERE clauses.
 *
 * 3. **Ciphertext bound to its home.** org id + provider ride along as
 *    AES-GCM additional authenticated data, so a row copied between orgs or
 *    relabelled between providers fails authentication outright. Moving a
 *    credential is a decrypt-and-re-encrypt by someone holding the key,
 *    never a row copy.
 *
 * Fail-closed: a missing or short CREDENTIALS_KEY throws. There is no
 * fallback to SESSION_SECRET or any other material — a fallback would
 * quietly reintroduce defect #1 the first time an env var went missing.
 */

const VERSION = 'v1';

function keyRoot(): string {
  const k = process.env.CREDENTIALS_KEY;
  if (!k || k.length < 32) {
    throw new Error(
      'CREDENTIALS_KEY is not set (need >=32 chars). Refusing to fall back to any other secret — ' +
        'credentials encryption uses its own root so it can be rotated independently.',
    );
  }
  return k;
}

function deriveOrgKey(orgId: string): Buffer {
  // Org id in the salt → per-org keys (departure #2).
  return crypto.scryptSync(keyRoot(), `selvedge-credentials-${VERSION}:${orgId}`, 32);
}

function aad(orgId: string, provider: string): Buffer {
  return Buffer.from(`${VERSION}:${orgId}:${provider}`, 'utf8');
}

/** Whether the vault can work at all — lets routes say so plainly instead of 500ing. */
export function vaultConfigured(): boolean {
  return (process.env.CREDENTIALS_KEY ?? '').length >= 32;
}

export function encryptCredential(orgId: string, provider: string, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveOrgKey(orgId), iv);
  cipher.setAAD(aad(orgId, provider));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptCredential(orgId: string, provider: string, enc: string): string {
  const parts = enc.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    // Unknown format or a version this build cannot read — never guess, never
    // return a partial value. The caller treats a throw as "no usable credential".
    throw new Error('credential ciphertext is malformed or from an unsupported version');
  }
  const [, ivB, tagB, ctB] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveOrgKey(orgId), Buffer.from(ivB, 'base64'));
  decipher.setAAD(aad(orgId, provider));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  // If the org, provider, key, or ciphertext is wrong, final() throws on the
  // auth tag — decryption fails closed rather than returning garbage.
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}