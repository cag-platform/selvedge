import type { Db } from '../../db/client.js';
import { useCredential } from '../credentials/store.js';

/**
 * The org's Supabase Management API token, from the credentials vault. Like the
 * host, a database is the customer's or nothing — there is NO managed fallback.
 * No token → null → the database connector is simply not connected for this org.
 */
export async function resolveSupabaseToken(db: Db, orgId: string): Promise<string | null> {
  return useCredential(db, orgId, 'supabase');
}
