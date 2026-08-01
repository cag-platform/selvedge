import type { Db } from '../db/client.js';
import { getCard, applyAction } from '../cards/store.js';
import { verifyCard, type VerifyContext, type VerifyResult, type VerifyDeps } from './run.js';
import { verdictReport, type CheckResult } from './verdict.js';

/**
 * The persistence bridge for verification: binds the pure orchestration to a
 * real card, so the verdict is written through the same machine-and-persist path
 * the owner API uses. `runChecks` stays injected — the evaluating-model check
 * runner is the deferred live piece, unverified-until-live like the agent.
 */
export type VerifyCardDeps = {
  runChecks: (ctx: VerifyContext) => Promise<CheckResult[]>;
  /** Ship and watch a passed change (deploy → observe → roll back on break). Optional. */
  shipAndObserve?: VerifyDeps['shipAndObserve'];
  now?: () => Date;
};

export type VerifyCardOutcome = VerifyResult | { outcome: 'not_found'; card: null };

export async function verifyCardForOrg(db: Db, orgId: string, cardId: string, deps: VerifyCardDeps): Promise<VerifyCardOutcome> {
  const card = await getCard(db, orgId, cardId);
  if (!card) return { outcome: 'not_found', card: null };

  return verifyCard(
    {
      apply: (action) => applyAction(db, orgId, cardId, action),
      runChecks: deps.runChecks,
      ...(deps.shipAndObserve ? { shipAndObserve: deps.shipAndObserve } : {}),
      now: deps.now ?? (() => new Date()),
    },
    card,
  );
}

/** Convenience for callers that already have check results (or none). */
export { verdictReport };
