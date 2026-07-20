import type { ContextPack, CapabilityGap } from '../../shared/types/pack.js';

/**
 * Group G — standing narration. No triggering event; the digest composer
 * calls these directly (digest-composer.md §2 STANDING/QUIET sections),
 * not through route()/narrate(). Phase 1 renders G1 as a plain standing
 * line with no cadence decay (brief non-goal: "no capability-gap drumbeat
 * rendering").
 */

export function capabilityGapLine(pack: ContextPack, gap: CapabilityGap): string {
  return `${pack.identity.name} is healthy — ${gap.summary}`;
}

export function quietProjectLine(names: string[]): string {
  if (names.length === 0) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} ${names.length === 1 ? 'was' : 'were'} quiet and healthy.`;
}

/** G3 — Sunday's mechanical weekly retrospective (Phase 1: counts, not prose; the "memory product" framing is a Phase 2 LLM upgrade). */
export function weeklyRetrospectiveLine(counts: { shipped: number; moved: number; stalled: number }): string {
  const parts: string[] = [];
  if (counts.shipped > 0) parts.push(`shipped ${counts.shipped} update${counts.shipped === 1 ? '' : 's'}`);
  if (counts.moved > 0) parts.push(`moved ${counts.moved} thing${counts.moved === 1 ? '' : 's'} forward`);
  if (counts.stalled > 0) parts.push(`${counts.stalled} stayed stalled`);
  if (parts.length === 0) return 'This week was quiet across the board.';
  return `This week you ${parts.join(', ')}.`;
}
