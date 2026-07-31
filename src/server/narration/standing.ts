import type { ContextPack, CapabilityGap } from '../../shared/types/pack.js';

/**
 * Group G — standing narration. No triggering event; the digest composer
 * calls these directly (digest-composer.md §2 STANDING/QUIET sections),
 * not through route()/narrate(). Phase 1 renders G1 as a plain standing
 * line with no cadence decay (brief non-goal: "no capability-gap drumbeat
 * rendering").
 */

/** Join names as "A", "A and B", "A, B and C". */
function nameList(names: string[]): string {
  return names.length === 1 ? (names[0] as string) : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * G1. Only claims "is healthy" when health is actually confirmed — the same
 * rule healthLine() applies on the project card. A gap on a project whose
 * health we cannot see is stated on its own; asserting calm we haven't
 * verified is the one prohibited move.
 */
export function capabilityGapLine(pack: ContextPack, gap: CapabilityGap): string {
  return pack.state?.serving_now?.healthy === true
    ? `${pack.identity.name} is healthy — ${gap.summary}`
    : `${pack.identity.name} — ${gap.summary}`;
}

/** G2a — the reassurance line. Only for projects whose health is confirmed. */
export function quietProjectLine(names: string[]): string {
  if (names.length === 0) return '';
  return `${nameList(names)} ${names.length === 1 ? 'was' : 'were'} quiet and healthy.`;
}

/**
 * G2b — the honest counterpart. A live project that sent no events and whose
 * health we cannot confirm is NOT reassuring news: silence from something we
 * can't see is exactly the case where "quiet and healthy" would be a false
 * all-clear. Say what is true instead.
 */
export function quietUnverifiedLine(names: string[]): string {
  if (names.length === 0) return '';
  const wasWere = names.length === 1 ? 'was' : 'were';
  return `${nameList(names)} ${wasWere} quiet, but I couldn't check ${names.length === 1 ? 'it' : 'them'} — no health signal came through.`;
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
