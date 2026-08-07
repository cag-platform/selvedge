import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { oauthStates } from '../db/schema/index.js';

/**
 * The short-lived handshake record for an OAuth round trip, held in the
 * database so it survives a redeploy and a second replica — see
 * db/schema/oauthStates.ts for why that matters more here than it does for the
 * in-memory version the GitHub setup router still uses.
 *
 * Two properties this file exists to hold:
 *   1. `state` is random, not a counter. A guessable state is what CSRF
 *      protection on an OAuth callback is *for*; the GitHub router's
 *      `setup_${counter++}` is guessable by anyone who can count.
 *   2. Taking a state consumes it. A replayed callback finds nothing and is
 *      refused, rather than exchanging a code twice.
 */

/** How long an owner has to finish the provider's consent screen. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export type OAuthHandshake = { orgId: string; provider: string; verifier: string | null };

export async function beginOAuthState(
  db: Db,
  orgId: string,
  provider: string,
  verifier: string | null = null,
): Promise<string> {
  const state = randomBytes(24).toString('base64url');
  await db.insert(oauthStates).values({ state, orgId, provider, verifier });
  return state;
}

/**
 * Consume a state, or null if it is unknown, expired, or for a different
 * provider. Deleting first means a replay finds nothing even if what follows
 * throws — an authorization code must never be exchangeable twice.
 */
export async function takeOAuthState(
  db: Db,
  state: string,
  provider: string,
  now: Date = new Date(),
): Promise<OAuthHandshake | null> {
  if (!state) return null;
  const rows = await db
    .delete(oauthStates)
    .where(and(eq(oauthStates.state, state), eq(oauthStates.provider, provider)))
    .returning({ orgId: oauthStates.orgId, provider: oauthStates.provider, verifier: oauthStates.verifier, createdAt: oauthStates.createdAt });

  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - row.createdAt.getTime() > OAUTH_STATE_TTL_MS) return null;
  return { orgId: row.orgId, provider: row.provider, verifier: row.verifier };
}

/** Drop handshakes nobody came back from. Called on the daily sweep. */
export async function sweepOAuthStates(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(oauthStates).where(lt(oauthStates.createdAt, new Date(now.getTime() - OAUTH_STATE_TTL_MS)));
}
