import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { companionTokens } from '../db/schema/index.js';

/**
 * The key a program on the owner's machine carries.
 *
 * Same discipline as the error beacon, for the same reason: the token is shown
 * exactly once at issue and only its SHA-256 hash is stored, so a database read
 * — a backup, a support session, a breach — can never recover a working key.
 *
 * Revocation is a timestamp rather than a delete: "when did this laptop stop
 * being allowed in?" is a question the record should be able to answer.
 */

const TOKEN_PREFIX = 'slv_'; // selvedge companion key

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type CompanionToken = typeof companionTokens.$inferSelect;

/** Issue a token for one machine. Returns the plaintext ONCE; it is never retrievable again. */
export async function issueCompanionToken(db: Db, orgId: string, name: string): Promise<{ id: string; token: string }> {
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const id = ulid();
  await db.insert(companionTokens).values({
    id,
    orgId,
    name: name.trim().slice(0, 80) || 'a machine',
    tokenHash: hashToken(token),
  });
  return { id, token };
}

/**
 * Resolve a presented token to its org, or null. Never throws.
 *
 * The hash comparison is done by the database's index (an equality lookup on a
 * hash, not on the secret), and the prefix check below is a cheap filter, not
 * the check itself.
 */
export async function resolveCompanionToken(db: Db, token: string | undefined | null): Promise<{ orgId: string; id: string } | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(token);
  const [row] = await db
    .select({ orgId: companionTokens.orgId, id: companionTokens.id, tokenHash: companionTokens.tokenHash })
    .from(companionTokens)
    .where(and(eq(companionTokens.tokenHash, hash), isNull(companionTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  // Belt and braces: constant-time compare of what came back, so a future
  // change to the lookup can't quietly turn this into a prefix match.
  const a = Buffer.from(row.tokenHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { orgId: row.orgId, id: row.id };
}

/** Note that a key was just used — the "last seen" a person checks when something looks wrong. */
export async function touchCompanionToken(db: Db, id: string): Promise<void> {
  await db.update(companionTokens).set({ lastUsedAt: new Date() }).where(eq(companionTokens.id, id)).catch(() => undefined);
}

/** Every key this org has issued, live and revoked. Never the secret. */
export async function listCompanionTokens(db: Db, orgId: string) {
  const rows = await db.select().from(companionTokens).where(eq(companionTokens.orgId, orgId));
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      created_at: r.createdAt.toISOString(),
      last_used_at: r.lastUsedAt?.toISOString() ?? null,
      revoked_at: r.revokedAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Stop a key working. Returns false when there is no such key for this org. */
export async function revokeCompanionToken(db: Db, orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(companionTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(companionTokens.orgId, orgId), eq(companionTokens.id, id), isNull(companionTokens.revokedAt)))
    .returning({ id: companionTokens.id });
  return rows.length > 0;
}
