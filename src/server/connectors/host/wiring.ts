import { isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { packs } from '../../db/schema/index.js';
import type { ContextPack, TopologySource } from '../../../shared/types/pack.js';
import type { ServiceToPoll } from './poller.js';
import { parseRailwayTarget, getDeployState as getRailwayDeployState } from '../railway/client.js';
import { resolveRailwayToken } from '../railway/resolve.js';
import { parseVercelTarget, getVercelDeployState } from '../vercel/client.js';
import { resolveVercelToken } from '../vercel/resolve.js';

/**
 * Live service discovery for the deploy poller — host-agnostic. It reads each
 * project's host source (Railway or Vercel) out of the pack topology, resolves
 * the org's own token for that host, and hands the poller a service with a
 * pre-bound `read`. A second host is a row in HOSTS, nothing more.
 *
 * Honesty over coverage, three times: a project with no host source is not
 * watched; a source whose resource_id doesn't address a real target is skipped,
 * not guessed; and a project whose org hasn't connected that host's token is
 * skipped, because a host we have no key for is "can't tell", never "fine".
 * Each skip is a silent no-op, never a fabricated state.
 *
 * The scan reads every live pack each tick and filters in code — fine at this
 * scale and single-process, matching the health monitor's discovery.
 */

type HostAdapter = {
  connector: 'railway' | 'vercel';
  resolveToken: (db: Db, orgId: string) => Promise<string | null>;
  /** Build a bound reader for this source, or null if the resource_id can't be addressed. */
  reader: (token: string, source: TopologySource) => (() => Promise<{ status: import('./deploy.js').HostDeployStatus } | null>) | null;
};

const HOSTS: HostAdapter[] = [
  {
    connector: 'railway',
    resolveToken: resolveRailwayToken,
    reader: (token, source) => {
      const target = parseRailwayTarget(source.resource_id);
      return target ? () => getRailwayDeployState(token, target) : null;
    },
  },
  {
    connector: 'vercel',
    resolveToken: resolveVercelToken,
    reader: (token, source) => {
      const target = parseVercelTarget(source.resource_id);
      return target ? () => getVercelDeployState(token, target) : null;
    },
  },
];

export async function listDeployServicesToPoll(db: Db): Promise<ServiceToPoll[]> {
  const rows = await db.select().from(packs).where(isNull(packs.archivedAt));
  const out: ServiceToPoll[] = [];

  // One token lookup per (org, host), not per service.
  const tokenCache = new Map<string, string | null>();
  const tokenFor = async (host: HostAdapter, orgId: string): Promise<string | null> => {
    const key = `${orgId}:${host.connector}`;
    if (!tokenCache.has(key)) tokenCache.set(key, await host.resolveToken(db, orgId));
    return tokenCache.get(key) ?? null;
  };

  for (const row of rows) {
    const pack = row.pack as ContextPack;
    for (const host of HOSTS) {
      const source = pack.topology.sources.find((s) => s.connector === host.connector);
      if (!source) continue;

      const token = await tokenFor(host, row.orgId);
      if (!token) continue; // not connected → don't claim to watch it

      const read = host.reader(token, source);
      if (!read) continue; // unaddressable → don't guess

      // A stable service id from the source; prefer the github repo for
      // source_account_id continuity with build events.
      const repoFullName =
        pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? row.projectId;

      out.push({
        orgId: row.orgId,
        projectId: row.projectId,
        source: host.connector,
        serviceId: source.resource_id,
        repoFullName,
        read,
      });
    }
  }

  return out;
}
