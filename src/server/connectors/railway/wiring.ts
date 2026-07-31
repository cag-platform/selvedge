import { isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { packs } from '../../db/schema/index.js';
import type { ContextPack } from '../../../shared/types/pack.js';
import { parseRailwayTarget } from './client.js';
import { resolveRailwayToken } from './resolve.js';
import type { ServiceToPoll } from './poller.js';

/**
 * Live service discovery for the Railway deploy poller — the seam that was
 * staged when the poller was built. It reads each project's Railway source out
 * of the pack topology, resolves the org's own Railway token, and hands the
 * poller a concrete service to watch.
 *
 * Honesty over coverage, three times: a project with no Railway source is not
 * watched (nothing to watch); a Railway source whose resource_id doesn't address
 * a real service is skipped, not guessed at; and a project whose org has not
 * connected a Railway token is skipped, because a host we have no key for is
 * "can't tell", never "fine". Each skip is a silent no-op, never a fabricated
 * state.
 *
 * The scan reads every live pack each tick and filters in code — fine at this
 * scale and single-process, matching the health monitor's discovery; if the
 * pack count ever grows past that, this is the place to push the railway-source
 * predicate into the query.
 */
export async function listDeployServicesToPoll(db: Db): Promise<ServiceToPoll[]> {
  const rows = await db.select().from(packs).where(isNull(packs.archivedAt));
  const out: ServiceToPoll[] = [];

  // One token lookup per org, not per service.
  const tokenByOrg = new Map<string, string | null>();

  for (const row of rows) {
    const pack = row.pack as ContextPack;
    const railwaySource = pack.topology.sources.find((s) => s.connector === 'railway');
    if (!railwaySource) continue;

    const target = parseRailwayTarget(railwaySource.resource_id);
    if (!target) continue; // unaddressable → don't guess

    if (!tokenByOrg.has(row.orgId)) tokenByOrg.set(row.orgId, await resolveRailwayToken(db, row.orgId));
    const token = tokenByOrg.get(row.orgId) ?? null;
    if (!token) continue; // no key → not connected → can't tell, so don't claim to watch it

    // Prefer the github source for source_account_id continuity with build
    // events; fall back to the project id.
    const repoFullName =
      pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? row.projectId;

    out.push({ orgId: row.orgId, projectId: row.projectId, target, token, repoFullName });
  }

  return out;
}
