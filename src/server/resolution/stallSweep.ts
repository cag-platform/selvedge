import type { Db } from '../db/client.js';
import { orgs } from '../db/schema/index.js';
import type { InProgressItem } from '../../shared/types/pack.js';
import { listPacks, updateMachineSections } from '../packs/store.js';
import { ingestResolvedEvent } from './ingest.js';

const STALL_THRESHOLD_DAYS = 14;

function isStalled(item: InProgressItem, now: Date): boolean {
  if (!item.last_activity_at) return false;
  const ageMs = now.getTime() - new Date(item.last_activity_at).getTime();
  return ageMs >= STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Daily cron (deliverable 4): in_progress items quiet past 14 days move to
 * stalled, and a code.branch_stalled (A5) event is ingested for each so it
 * shows up in the digest — "still want this?", at most once per item since
 * it only ever transitions in_progress -> stalled a single time.
 */
export async function sweepOrgForStalls(db: Db, orgId: string, now: Date = new Date()): Promise<number> {
  const packs = await listPacks(db, orgId);
  let stalledCount = 0;

  for (const pack of packs) {
    const inProgress = pack.state?.in_progress ?? [];
    const toStall = inProgress.filter((item) => isStalled(item, now));
    if (toStall.length === 0) continue;

    const stillActive = inProgress.filter((item) => !isStalled(item, now));
    const alreadyStalled = pack.state?.stalled ?? [];

    await updateMachineSections(db, orgId, pack.identity.project_id, {
      state: { in_progress: stillActive, stalled: [...alreadyStalled, ...toStall] },
    });

    const source = pack.topology.sources.find((s) => s.role === 'source_of_truth') ?? pack.topology.sources[0];
    if (!source) continue;

    for (const item of toStall) {
      await ingestResolvedEvent(db, pack.identity.project_id, {
        org_id: orgId,
        source: source.connector,
        source_account_id: source.resource_id,
        event_type: 'code.branch_stalled',
        occurred_at: now.toISOString(),
        severity_hint: 'warn',
        raw: { ref: item.ref },
        dedupe_key: `stall:${orgId}:${pack.identity.project_id}:${item.ref}`,
      });
      stalledCount++;
    }
  }

  return stalledCount;
}

export async function runStallSweep(db: Db, now: Date = new Date()): Promise<number> {
  const allOrgs = await db.select({ orgId: orgs.orgId }).from(orgs);
  let total = 0;
  for (const { orgId } of allOrgs) {
    total += await sweepOrgForStalls(db, orgId, now);
  }
  return total;
}
