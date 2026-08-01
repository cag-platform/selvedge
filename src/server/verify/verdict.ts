import type { CardVerdict } from '../cards/types.js';

/**
 * The five-value verdict — the honesty heart of Phase 4 (BUILD-BRIEF: "every
 * change ends with a verdict you can trust, including 'I can't tell'"). This is
 * the one place a change's outcome is decided, and it is built to be honest
 * under pressure: it inflates NOTHING. It reaches 'verified' only when the work
 * was actually confirmed, drops to 'inconclusive' the moment it can't tell, and
 * calls a regression what it is — the change didn't work — rather than papering
 * over it.
 *
 * The checks it reasons over:
 *   smoke      — does the app still run and respond at all?
 *   regression — does everything that worked before still work?
 *   acceptance — does the change actually do what was asked (net-new work)?
 *
 * Each check either passed, failed, or could-not-run. `could_not_run` is a
 * first-class outcome, never silently treated as a pass — an unrun check is an
 * absence of evidence, and this verdict never reads absence of evidence as
 * evidence of success.
 *
 * `stopped` is NOT produced here — it comes from the machine when a card is
 * halted (cap or owner). Verification only ever returns one of the other four.
 */

export type CheckKind = 'smoke' | 'regression' | 'acceptance';
export type CheckOutcome = 'pass' | 'fail' | 'could_not_run';

export type CheckResult = {
  kind: CheckKind;
  /** A plain name for the check, for the owner-facing explanation. */
  name: string;
  outcome: CheckOutcome;
  detail?: string;
};

export type VerifyVerdict = Exclude<CardVerdict, 'stopped'>;

export type VerdictReport = {
  verdict: VerifyVerdict;
  /** One plain sentence the owner can trust, matching the verdict exactly. */
  summary: string;
  /** The checks that drove it, for the technical register. */
  results: CheckResult[];
};

function has(results: CheckResult[], kind: CheckKind, outcome: CheckOutcome): boolean {
  return results.some((r) => r.kind === kind && r.outcome === outcome);
}

/**
 * Decide the verdict from the checks that ran. The rules, in priority order:
 *
 *   1. Nothing was checked → inconclusive. No evidence, no verdict.
 *   2. Any check FAILED → didn't_work. A regression (something that worked is now
 *      broken) counts: the change did not land safely, whatever else passed.
 *   3. Smoke could not even be confirmed to run → inconclusive. If we can't show
 *      the app still responds, we cannot claim anything above "I can't tell".
 *   4. Acceptance passed (and nothing failed, smoke is good) → verified.
 *   5. Otherwise (runs, nothing broke, but the change's intent wasn't confirmed)
 *      → probably. Common for net-new work with no derivable acceptance check.
 */
export function computeVerdict(results: CheckResult[]): VerifyVerdict {
  if (results.length === 0) return 'inconclusive';

  if (results.some((r) => r.outcome === 'fail')) return 'didnt_work';

  // A verdict above "I can't tell" needs proof the app still runs.
  if (!has(results, 'smoke', 'pass')) return 'inconclusive';

  if (has(results, 'acceptance', 'pass')) return 'verified';

  return 'probably';
}

const SUMMARY: Record<VerifyVerdict, string> = {
  verified: 'Verified — I confirmed the change does what you asked and nothing else broke.',
  probably: "Probably working — the app runs and nothing I could check broke, but I couldn't fully confirm the change itself.",
  inconclusive: "I can't tell — I couldn't run enough checks to be sure. I'd rather say so than guess.",
  didnt_work: "It didn't work — a check failed, so I'm not shipping this as-is.",
};

/** The verdict plus a plain, matching summary and the checks behind it. */
export function verdictReport(results: CheckResult[]): VerdictReport {
  const verdict = computeVerdict(results);
  return { verdict, summary: SUMMARY[verdict], results };
}
