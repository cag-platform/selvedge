import type { Db } from '../../db/client.js';
import { useCredential } from '../credentials/store.js';

/**
 * The org's Railway token, from the credentials vault. Unlike fuel, a host has
 * NO managed fallback: the Railway account is the customer's, and Selvedge acts
 * on it only with a token they granted. No token → null → the host connector
 * is simply not connected for this org, and deploy state is "can't tell".
 */
export async function resolveRailwayToken(db: Db, orgId: string): Promise<string | null> {
  return useCredential(db, orgId, 'railway');
}
