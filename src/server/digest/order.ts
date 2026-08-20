import { withTimesSuffix } from '../../shared/repeats.js';
import type { ContextPack, StakesTier } from '../../shared/types/pack.js';
import type { GatheredNarration } from './gather.js';

export type NarrationWithPack = GatheredNarration & { pack: ContextPack | null };

const TIER_RANK: Record<StakesTier, number> = { live_critical: 0, live_small: 1, personal: 2, sandbox: 3 };
const VERDICT_RANK: Record<string, number> = { users_affected: 0, cannot_tell: 1, users_fine: 2 };

/** digest-composer §3: stakes tier desc -> users-affected verdicts first -> money-touching first -> oldest first (age is urgency). */
export function orderAttention(items: NarrationWithPack[]): NarrationWithPack[] {
  return [...items].sort((a, b) => {
    const tierA = a.pack ? TIER_RANK[a.pack.stakes.tier] : 4; // org-level (no pack) items rank above nothing, below any real project? surfaced first: keep at top.
    const tierB = b.pack ? TIER_RANK[b.pack.stakes.tier] : 4;
    if (!a.pack) return -1;
    if (!b.pack) return 1;
    if (tierA !== tierB) return tierA - tierB;

    const verdictA = VERDICT_RANK[a.verdict ?? ''] ?? 3;
    const verdictB = VERDICT_RANK[b.verdict ?? ''] ?? 3;
    if (verdictA !== verdictB) return verdictA - verdictB;

    const moneyA = a.pack.stakes.touches_money ? 0 : 1;
    const moneyB = b.pack.stakes.touches_money ? 0 : 1;
    if (moneyA !== moneyB) return moneyA - moneyB;

    return a.occurredAt.getTime() - b.occurredAt.getTime(); // oldest (most overdue) first
  });
}

/**
 * Collapse identical (project, fragment) repeats into ONE line with a plain
 * count — three "new work landed on the main branch today" lines are one fact
 * that happened three times, not three facts. The first occurrence keeps its
 * narration id (feedback and traceability attach there); order is preserved.
 */
export function collapseRepeats(items: NarrationWithPack[]): NarrationWithPack[] {
  const byKey = new Map<string, { item: NarrationWithPack; count: number }>();
  let uniqueId = 0;
  for (const item of items) {
    // Items with no fragment can't be duplicates of anything — always unique.
    const key = item.fragment ? `${item.projectId ?? ''}|${item.fragment}` : `#${uniqueId++}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { item, count: 1 });
  }
  return [...byKey.values()].map(({ item, count }) =>
    count > 1 && item.fragment ? { ...item, fragment: withTimesSuffix(item.fragment, count) } : item,
  );
}

/** digest-composer §3: milestone (A4) first, then live_critical ships, then the rest. */
export function orderMoved(items: NarrationWithPack[]): NarrationWithPack[] {
  return [...items].sort((a, b) => {
    const meta = (row: NarrationWithPack) => (row.meta as { row_id?: string } | null)?.row_id;
    const milestoneA = meta(a) === 'A4' ? 0 : 1;
    const milestoneB = meta(b) === 'A4' ? 0 : 1;
    if (milestoneA !== milestoneB) return milestoneA - milestoneB;

    const criticalA = a.pack?.stakes.tier === 'live_critical' ? 0 : 1;
    const criticalB = b.pack?.stakes.tier === 'live_critical' ? 0 : 1;
    if (criticalA !== criticalB) return criticalA - criticalB;

    return a.occurredAt.getTime() - b.occurredAt.getTime();
  });
}
