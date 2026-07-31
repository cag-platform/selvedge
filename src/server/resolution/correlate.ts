/**
 * Change→break correlation (BUILD-BRIEF Phase 2). Now that code, build, deploy,
 * and runtime events all land on one per-project timeline, a break can be lined
 * up against the change that came just before it — "this started right after new
 * code went live." That single sentence is the difference between a scary,
 * causeless alert and one the owner can act on.
 *
 * Two honesty rules govern this, because a wrong culprit is worse than none:
 *
 *   1. Correlation is never dressed as proven cause. The language is always
 *      "started right after" / "worth checking first", never "was caused by".
 *      A change close in time is a lead, not a verdict.
 *   2. No change in the window, no claim. If nothing shipped before the break,
 *      this returns null and the owner is told nothing — we never reach further
 *      back to manufacture a suspect. "I don't see a change that explains this"
 *      is the honest outcome, expressed as silence here.
 */

/** Events that represent a change reaching the running app — a plausible trigger. */
const CHANGE_EVENTS = new Set<string>([
  'code.commits_landed_default',
  'code.large_merge',
  'build.succeeded',
]);

/** Events that represent something breaking — the thing we look back from. */
const BREAK_EVENTS = new Set<string>([
  'runtime.health_failing',
  'deploy.failed_previous_serving',
  'deploy.failed_nothing_serving',
  'runtime.error_rate_spike',
  'data.migration_failed',
]);

export function isBreakEvent(eventType: string): boolean {
  return BREAK_EVENTS.has(eventType);
}

export function isChangeEvent(eventType: string): boolean {
  return CHANGE_EVENTS.has(eventType);
}

/** A change event on the same project, as a candidate cause. */
export type ChangeCandidate = {
  eventId: string;
  eventType: string;
  occurredAt: Date;
};

/** How far back a change can be and still plausibly explain a break. */
export const CORRELATION_WINDOW_MS = 60 * 60 * 1000;

export type Correlation = {
  changeEventId: string;
  changeType: string;
  occurredAt: string;
  minutesBefore: number;
  /** Plain-register line for the owner — a lead, not a verdict. */
  plain: string;
  /** Technical-register line, with the explicit correlation-not-cause caveat. */
  technical: string;
};

function whenPhrase(minutes: number): string {
  if (minutes < 2) return 'moments after';
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} after`;
  return 'about an hour after';
}

function changePhrase(changeType: string): string {
  switch (changeType) {
    case 'build.succeeded':
      return 'a new version went live';
    case 'code.large_merge':
      return 'a large change landed on your main branch';
    case 'code.commits_landed_default':
    default:
      return 'new code landed on your main branch';
  }
}

/**
 * Pick the change most likely to be behind a break: the most recent change on
 * the same project that lands strictly before the break and within the window.
 * Candidates are assumed already scoped to one project; anything outside the
 * window or not before the break is ignored. Returns null when nothing fits —
 * no fabricated culprit.
 */
export function correlateChange(
  breakType: string,
  breakOccurredAt: Date,
  candidates: ChangeCandidate[],
  windowMs: number = CORRELATION_WINDOW_MS,
): Correlation | null {
  if (!isBreakEvent(breakType)) return null;

  const windowStart = breakOccurredAt.getTime() - windowMs;
  const inWindow = candidates.filter(
    (c) =>
      isChangeEvent(c.eventType) &&
      c.occurredAt.getTime() < breakOccurredAt.getTime() &&
      c.occurredAt.getTime() >= windowStart,
  );
  if (inWindow.length === 0) return null;

  // The closest change before the break is the strongest lead.
  const best = inWindow.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
  const minutesBefore = Math.round((breakOccurredAt.getTime() - best.occurredAt.getTime()) / 60000);

  return {
    changeEventId: best.eventId,
    changeType: best.eventType,
    occurredAt: best.occurredAt.toISOString(),
    minutesBefore,
    plain: `This started ${whenPhrase(minutesBefore)} ${changePhrase(best.eventType)} — worth checking first.`,
    technical: `Correlated change: ${best.eventType} at ${best.occurredAt.toISOString()} (${minutesBefore} min before). Correlation, not a confirmed cause.`,
  };
}
