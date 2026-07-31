import type { Db } from '../../db/client.js';
import { useCredential } from '../credentials/store.js';

/**
 * The org's Vercel token, from the credentials vault. Like Railway, a host has
 * NO managed fallback: the Vercel account is the customer's, and Selvedge acts
 * on it only with a token they granted. No token → null → not connected, and
 * deploy state is "can't tell".
 */
export async function resolveVercelToken(db: Db, orgId: string): Promise<string | null> {
  return useCredential(db, orgId, 'vercel');
}
