import type { Card } from '../cards/types.js';
import type { CardAction } from '../cards/machine.js';
import type { ApplyResult } from '../cards/store.js';
import type { SandboxHandle } from '../runner/types.js';
import { verdictReport, type CheckResult, type VerdictReport } from './verdict.js';

/**
 * The verify orchestration — what runs when a card reaches `verifying`. It runs
 * the checks, computes the five-value verdict, and drives the card to
 * `complete`, carrying the honest summary and the checks behind it onto the
 * card's history.
 *
 * Like the runner, everything that touches the outside world is injected, so the
 * orchestration is pure and testable. `runChecks` is the seam that generates and
 * runs smoke / regression / acceptance checks — in production against a different
 * (evaluating) model than the one that authored the change, so the verdict never
 * grades its own work. That separation is a property of the injected impl; this
 * layer just consumes the results.
 *
 * The one honesty rule here: if the checks cannot be run at all — the runner
 * throws, the sandbox is gone — the verdict is NOT a crash and NOT a hidden
 * success. It is `inconclusive`, exactly what an empty result set produces:
 * "I couldn't check, so I won't claim it worked."
 */

export type VerifyContext = {
  card: Card;
  /** A workspace for running checks, when the injected runner needs one. */
  sandbox?: SandboxHandle;
};

export type VerifyDeps = {
  /** Drive the card through the machine + persistence (the store's applyAction, bound to org+card). */
  apply: (action: CardAction) => Promise<ApplyResult>;
  /** Generate and run the checks. Real impl uses the evaluating model + sandbox. */
  runChecks: (ctx: VerifyContext) => Promise<CheckResult[]>;
  now: () => Date;
};

export type VerifyOutcome = 'completed' | 'not_verifiable';
export type VerifyResult = { outcome: VerifyOutcome; card: Card; report: VerdictReport };

export async function verifyCard(deps: VerifyDeps, card: Card): Promise<VerifyResult> {
  if (card.state !== 'verifying') {
    return { outcome: 'not_verifiable', card, report: verdictReport([]) };
  }

  let results: CheckResult[];
  try {
    results = await deps.runChecks({ card });
  } catch {
    // Couldn't run the checks → honest "I can't tell", never a hidden pass.
    results = [];
  }

  const report = verdictReport(results);
  const done = await deps.apply({
    type: 'complete',
    at: deps.now().toISOString(),
    verdict: report.verdict,
    summary: report.summary,
    results: report.results,
  });

  return { outcome: done.ok ? 'completed' : 'not_verifiable', card: done.ok ? done.card : card, report };
}
