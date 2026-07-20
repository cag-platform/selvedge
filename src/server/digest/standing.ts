import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { capabilityGapLine, quietProjectLine, unsortedTrayNarration, weeklyRetrospectiveLine } from '../narration/index.js';
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

/** G2: projects with tier >= live_small, healthy, and no narration in today's window — one reassurance line, not silence. */
export function quietLine(packs: ContextPack[], projectIdsWithActivity: Set<string>): string {
  const quietTiers = new Set(['live_small', 'live_critical']);
  const names = packs
    .filter((p) => quietTiers.has(p.stakes.tier) && !projectIdsWithActivity.has(p.identity.project_id))
    .map((p) => p.identity.name);
  return quietProjectLine(names);
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
