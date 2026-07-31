import type { Card } from '../cards/types.js';
import type { RunnerDeps, RunResult, SandboxHandle } from './types.js';

/**
 * The agent runner's pure orchestration core — the `work` phase of the loop.
 * It provisions a sandbox, iterates the injected agent, and drives the card
 * through the machine, and it exists to hold three safety properties while real
 * code is being changed:
 *
 *   1. It obeys the halt. After EVERY step's spend it re-reads the card, and the
 *      instant the machine says `stopped` (cap reached) or `blocked` (a staged
 *      checkpoint), it stops — no further agent step runs. The cap can never be
 *      overspent by "one more iteration".
 *   2. It never leaks a sandbox. The workspace is torn down in a finally, so a
 *      cap stop, a checkpoint pause, an agent crash, and a clean finish all
 *      release it. (The agent is expected to persist progress to a WIP branch
 *      each step, so a resume after a checkpoint is cheap even though the
 *      sandbox itself is fresh.)
 *   3. It cannot run forever. A loop-stall backstop caps the iterations; an agent
 *      that never reports `done` fails the card rather than burning to the cap.
 *
 * It runs a card that is `approved` (starting work) or `working` (resuming after
 * a checkpoint the owner continued); anything else is `not_runnable` and no work
 * is done.
 */

const DEFAULT_MAX_STEPS = 50;

export async function runCard(deps: RunnerDeps, card: Card): Promise<RunResult> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;

  // Entry gate: begin work from `approved`, or resume from `working`.
  let current = card;
  if (current.state === 'approved') {
    const started = await deps.apply({ type: 'start_work', at: deps.now().toISOString() });
    if (!started.ok) return { outcome: 'not_runnable', card: current };
    current = started.card;
  } else if (current.state !== 'working') {
    return { outcome: 'not_runnable', card: current };
  }

  let sandbox: SandboxHandle | null = null;
  try {
    sandbox = await deps.sandbox.create(current);

    for (let step = 1; step <= maxSteps; step++) {
      let result;
      try {
        result = await deps.agentStep({ card: current, sandbox, step });
      } catch (err) {
        const failed = await deps.apply({
          type: 'fail',
          at: deps.now().toISOString(),
          reason: `The agent hit an error: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { outcome: 'failed', card: failed.ok ? failed.card : current };
      }

      // Record the step's cost, which is what the cap and checkpoints act on. A
      // zero-cost step (a no-op iteration) records nothing but can still finish.
      if (result.spentCents > 0) {
        const spent = await deps.apply({
          type: 'spend',
          at: deps.now().toISOString(),
          cents: result.spentCents,
          detail: result.note,
        });
        if (!spent.ok) {
          // The only spend rejection from `working` is a bad amount; treat a
          // malformed cost as an agent fault rather than silently continuing.
          const failed = await deps.apply({ type: 'fail', at: deps.now().toISOString(), reason: 'The agent reported an invalid cost.' });
          return { outcome: 'failed', card: failed.ok ? failed.card : current };
        }
        current = spent.card;

        // Obey the halt: the machine has the authority, not the loop.
        if (current.state === 'stopped') return { outcome: 'stopped', card: current };
        if (current.state === 'blocked') return { outcome: 'checkpoint', card: current };
      }

      if (result.done) {
        const verifying = await deps.apply({ type: 'begin_verify', at: deps.now().toISOString() });
        return { outcome: verifying.ok ? 'ready_to_verify' : 'failed', card: verifying.ok ? verifying.card : current };
      }
    }

    // Ran out of iterations without finishing — a loop-stall, not a silent burn.
    const stalled = await deps.apply({
      type: 'fail',
      at: deps.now().toISOString(),
      reason: `Stopped after ${maxSteps} steps without finishing — I don't want to keep spending on this without checking with you.`,
    });
    return { outcome: 'failed', card: stalled.ok ? stalled.card : current };
  } finally {
    if (sandbox) {
      await deps.sandbox.destroy(sandbox).catch(() => {
        /* teardown is best-effort; a leaked-sandbox alarm is the provider's job, not a reason to crash the run */
      });
    }
  }
}
