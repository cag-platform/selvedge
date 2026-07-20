import { and, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, packs } from '../db/schema/index.js';
import { estimateDeployCadence } from '../connectors/github/backfill.js';
import { updateMachineSections } from '../packs/store.js';
import type { ContextPack } from '../../shared/types/pack.js';

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMIT_EVENT_TYPES = ['code.commits_landed_default', 'code.commit_pushed_non_default', 'code.large_merge'];

export type BaselineShift = { orgId: string; projectId: string; from: string; to: string };

/**
 * Anti-rot (Ironclad 1, part B): a learned baseline that drifts from reality is
 * worse than none. This re-derives each project's deploy cadence from the last
 * 30 days of *stored* commit events (no GitHub round-trip) on a rolling window,
 * so "normal" tracks reality. When the cadence has genuinely shifted, the
 * baseline updates and the shift is returned so the brief can note it ("your
 * deploy rhythm changed this month").
 */
export async function revalidateBaselines(db: Db, now: Date = new Date()): Promise<BaselineShift[]> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const packRows = await db.select().from(packs);
  const shifts: BaselineShift[] = [];

  for (const row of packRows) {
    const pack = row.pack as ContextPack;
    const current = pack.baselines?.deploy_cadence;
    if (!current) continue; // nothing to re-validate until a baseline exists

    const commitEvents = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.orgId, row.orgId),
          eq(events.projectId, row.projectId),
          gte(events.occurredAt, since),
          inArray(events.eventType, COMMIT_EVENT_TYPES),
        ),
      );

    const recomputed = estimateDeployCadence(commitEvents.length);
    if (recomputed !== current) {
      await updateMachineSections(db, row.orgId, row.projectId, { baselines: { deploy_cadence: recomputed } });
      shifts.push({ orgId: row.orgId, projectId: row.projectId, from: current, to: recomputed });
    }
  }

  return shifts;
}
