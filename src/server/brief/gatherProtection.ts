import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import { resolveRailwayToken } from '../connectors/railway/resolve.js';
import { resolveSupabaseToken } from '../connectors/supabase/resolve.js';
import { composeProtectionBrief, coverageFromPack, type ProtectionBrief } from './protection.js';

/**
 * Gather the live coverage for an org's app and compose its protection brief.
 * "Connected" for runtime and data means a token actually resolves — not
 * merely that the pack lists a host or database. Claiming coverage we can't
 * back with a live connection is the false-calm the brief exists to avoid.
 *
 * Returns null when the app has no pack (nothing to brief on).
 */
export async function gatherProtectionBrief(db: Db, orgId: string, projectId: string): Promise<ProtectionBrief | null> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return null;

  const [hostToken, dbToken] = await Promise.all([
    resolveRailwayToken(db, orgId),
    resolveSupabaseToken(db, orgId),
  ]);

  const coverage = coverageFromPack(pack, {
    host: hostToken !== null,
    database: dbToken !== null,
  });
  return composeProtectionBrief(pack, coverage);
}
