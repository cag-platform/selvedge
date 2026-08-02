import type { Db } from '../../db/client.js';
import { railwayAccessToken } from './oauth.js';

/**
 * The org's Railway token. Unlike fuel, a host has NO managed fallback: the
 * Railway account is the customer's, and Selvedge acts on it only with a key
 * they granted. No token → null → the host connector is simply not connected
 * for this org, and deploy state is "can't tell".
 *
 * Goes through the OAuth path because a "Login with Railway" access token lives
 * only an hour and its refresh token rotates. That path also handles a pasted
 * API key unchanged — such a token is just a set that never expires — so both
 * ways of connecting read identically from here.
 */
export async function resolveRailwayToken(db: Db, orgId: string): Promise<string | null> {
  return railwayAccessToken(db, orgId);
}
