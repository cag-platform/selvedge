import type { Db } from '../db/client.js';
import { runCardForOrg, type RunCardDeps, type RunCardOutcome } from '../runner/factory.js';
import { verifyCardForOrg, type VerifyCardDeps, type VerifyCardOutcome } from '../verify/factory.js';

/**
 * The back half of the loop, composed: take an approved card from work through
 * verification in one call. The runner does the change and lands the card in
 * `verifying`; only THEN does verification run and produce the verdict. If the
 * run doesn't reach verification — a cap stop, a checkpoint pause, a failure —
 * the drive stops there and does not verify a change that wasn't finished.
 *
 * Both halves are injected (the agent + sandbox for the run, the check runner
 * for verify), so this composition is correct and tested now, ahead of those
 * live pieces existing. It is the assembly point, not a fake: with real adapters
 * it runs the whole loop; with none it simply reports the card wasn't runnable.
 */

export type DriveDeps = {
  runner: RunCardDeps;
  verify: VerifyCardDeps;
};

export type DriveResult =
  | { phase: 'run'; run: RunCardOutcome }
  | { phase: 'verify'; run: RunCardOutcome; verify: VerifyCardOutcome };

export async function driveCard(db: Db, orgId: string, cardId: string, deps: DriveDeps): Promise<DriveResult> {
  const run = await runCardForOrg(db, orgId, cardId, deps.runner);

  // Only a run that finished the work reaches verification.
  if (run.outcome !== 'ready_to_verify') {
    return { phase: 'run', run };
  }

  const verify = await verifyCardForOrg(db, orgId, cardId, deps.verify);
  return { phase: 'verify', run, verify };
}
