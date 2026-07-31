import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { deriveProjectStatus } from '../packs/healthLine.js';
import { capabilityGapLine, quietProjectLine, quietUnverifiedLine, unsortedTrayNarration, weeklyRetrospectiveLine } from '../narration/index.js';
import { listUnsortedEvents } from '../resolution/unsortedTray.js';
import { narrations } from '../db/schema/index.js';
import { and, eq, gte, lt } from 'drizzle-orm';

/** G1: capability_gaps present on a live project. No cadence decay in Phase 1 (brief non-goal) — shown every day it applies. */
export function capabilityGapStandingLines(packs: ContextPack[]): string[] {
  const lines: string[] = [];
  for (const pack of packs) {
    if (pack.stakes.tier === 'sandbox') continue;
    for (const gap of pack.topology.capability_gaps ?? []) {
      lines.push(capabilityGapLine(pack, gap));
    }
  }
  return lines;
}

/**
 * G2: live projects with no narration in today's window — a reassurance line
 * rather than silence.
 *
 * The reassurance is split by what we can actually verify. Previously this
 * filtered on tier and silence alone and then said "quiet and healthy" about
 * every one of them, so a live_critical project whose connector had died —
 * the exact case the owner most needs to hear about — was reported as healthy
 * *because* no events arrived. Absence of news is not health.
 *
 * Confirmed healthy → the reassurance. Unverifiable → said plainly. Projects
 * that are down or carrying a known gap are excluded here; the attention and
 * capability-gap lines already own them.
 */
export function quietLine(packs: ContextPack[], projectIdsWithActivity: Set<string>): string {
  const quietTiers = new Set(['live_small', 'live_critical']);
  const quiet = packs.filter(
    (p) => quietTiers.has(p.stakes.tier) && !projectIdsWithActivity.has(p.identity.project_id),
  );

  const healthy: string[] = [];
  const unverified: string[] = [];
  for (const pack of quiet) {
    const status = deriveProjectStatus(pack);
    if (status === 'healthy') healthy.push(pack.identity.name);
    else if (status === 'unknown') unverified.push(pack.identity.name);
  }

  return [quietProjectLine(healthy), quietUnverifiedLine(unverified)].filter(Boolean).join(' ');
}

/** E4: unmappable events piling up in the unsorted tray. */
export async function unsortedTrayLine(db: Db, orgId: string): Promise<string | null> {
  const tray = await listUnsortedEvents(db, orgId, 1000);
  if (tray.length === 0) return null;
  return unsortedTrayNarration(tray.length).fragment;
}

/** G3: Sunday's mechanical weekly retrospective. */
export async function weeklyRetrospective(db: Db, orgId: string, weekEnd: Date): Promise<string | null> {
  if (weekEnd.getUTCDay() !== 0) return null; // Sunday only (weekEnd is local-midnight-as-computed by the caller)
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(narrations)
    .where(and(eq(narrations.orgId, orgId), gte(narrations.occurredAt, weekStart), lt(narrations.occurredAt, weekEnd)));

  const shipped = rows.filter((r) => (r.meta as { row_id?: string } | null)?.row_id === 'B2').length;
  const moved = rows.filter((r) => r.kind === 'moved').length;
  const stalled = rows.filter((r) => (r.meta as { row_id?: string } | null)?.row_id === 'A5').length;

  return weeklyRetrospectiveLine({ shipped, moved, stalled });
}
