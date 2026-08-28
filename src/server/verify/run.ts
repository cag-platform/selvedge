import type { Card } from '../cards/types.js';
import type { CardAction } from '../cards/machine.js';
import type { ApplyResult } from '../cards/store.js';
import type { WorkspaceHandle } from '../workspace/types.js';
import { verdictReport, type CheckResult, type VerdictReport } from './verdict.js';
import { verdictAfterObservation, type ObserveResult } from './observe.js';

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
  workspace?: WorkspaceHandle;
};

export type VerifyDeps = {
  /** Drive the card through the machine + persistence (the store's applyAction, bound to org+card). */
  apply: (action: CardAction) => Promise<ApplyResult>;
  /** Generate and run the checks. Real impl uses the evaluating model + sandbox. */
  runChecks: (ctx: VerifyContext) => Promise<CheckResult[]>;
  /**
   * What a graded acceptance is worth when the grader DID grade: 'independent'
   * when the grader's provider differs from the author's, 'same_model' when it
   * doesn't — decided where both providers are known (the factory), disclosed
   * here. Only applied when an acceptance check actually resolved to pass or
   * fail; a grader that was configured but answered "can't tell" (or never ran)
   * leaves the card 'ungraded'. Configuration is not provenance.
   */
  graderProvenance?: 'independent' | 'same_model';
  /**
   * Ship the change and watch it in production (deploy → observe → roll back on
   * a confirmed break). Injected, host-specific. Present only when the change is
   * actually deployable; when absent, the pre-deploy verdict stands as-is.
   */
  shipAndObserve?: (ctx: VerifyContext) => Promise<ObserveResult>;
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

  let report = verdictReport(results);

  // Post-deploy observation: only a change that passed its checks is shipped and
  // watched. If it breaks the app in the window, the injected ship-and-observe
  // has already rolled it back, and the verdict becomes didnt_work — the
  // pre-deploy checks were not the last word, production was.
  if (deps.shipAndObserve && (report.verdict === 'verified' || report.verdict === 'probably')) {
    try {
      const observed = await deps.shipAndObserve({ card });
      const folded = verdictAfterObservation(report.verdict, observed);
      report = { verdict: folded.verdict, summary: folded.summary, results: report.results };
    } catch {
      // Couldn't ship or watch → we can't claim it held. Honest inconclusive.
      report = verdictReport([]);
    }
  }

  // Graded means an acceptance check actually resolved to pass or fail — the
  // only way that happens is a judge reading the diff. could_not_run (no
  // grader, no evidence, over budget, or an honest "can't tell") is not a
  // grade, whatever was configured.
  const acceptanceJudged = report.results.some(
    (r) => r.kind === 'acceptance' && (r.outcome === 'pass' || r.outcome === 'fail'),
  );
  const gradedBy = acceptanceJudged ? (deps.graderProvenance ?? 'ungraded') : 'ungraded';

  const done = await deps.apply({
    type: 'complete',
    at: deps.now().toISOString(),
    verdict: report.verdict,
    gradedBy,
    summary: report.summary,
    results: report.results,
  });

  return { outcome: done.ok ? 'completed' : 'not_verifiable', card: done.ok ? done.card : card, report };
}
