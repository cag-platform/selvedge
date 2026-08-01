import type { ProbeResult } from '../monitor/probe.js';
import type { VerifyVerdict } from './verdict.js';

/**
 * The post-deploy observation window (BUILD-BRIEF Phase 4). A change that passed
 * its checks isn't trusted until it has survived a brief watch in production:
 * ship it, watch the live app, and if it breaks within the window, roll it back.
 * This is where the verdict meets reality — the last guard before a change is
 * left standing.
 *
 * It reuses the monitor's two-failure debounce exactly: a single failed probe
 * never triggers a rollback (a blip that clears is not a regression), and a
 * rollback fires only on the SECOND consecutive failure. The false-calm rule's
 * mirror image — we are as reluctant to cry "it broke" as to cry "it's fine".
 *
 * Everything external is injected — the probe, the rollback, the clock, the
 * wait — so the window logic is testable without a network or real time. The
 * rollback itself is host-specific and deferred, unverified-until-live.
 */

export type ObserveState = { consecutiveFailures: number; samples: number };
export const OBSERVE_FRESH: ObserveState = { consecutiveFailures: 0, samples: 0 };

/** Consecutive failed probes before we call it broken. The monitor's value. */
export const OBSERVE_FAILURE_THRESHOLD = 2;

/** Fold one probe into the window state and decide whether it has broken. */
export function stepObservation(prev: ObserveState, result: ProbeResult): { state: ObserveState; broke: boolean } {
  const samples = prev.samples + 1;
  if (result.up) {
    return { state: { consecutiveFailures: 0, samples }, broke: false };
  }
  const consecutiveFailures = prev.consecutiveFailures + 1;
  return { state: { consecutiveFailures, samples }, broke: consecutiveFailures >= OBSERVE_FAILURE_THRESHOLD };
}

export type ObserveDeps = {
  /** Probe the live app. Injected — the monitor's runCheck against the app's URL in production. */
  probe: () => Promise<ProbeResult>;
  /** Revert the deploy. Injected, host-specific. Called only on a confirmed break. */
  rollback: () => Promise<void>;
  now: () => number;
  /** Wait between probes. Injected so tests don't spend real time. */
  sleep: (ms: number) => Promise<void>;
  /** Total watch duration and probe cadence. */
  windowMs: number;
  intervalMs: number;
};

export type ObserveResult = { outcome: 'held' | 'broke'; rolledBack: boolean; samples: number };

/**
 * Watch the live app across the window. Returns 'broke' (and rolls back) on the
 * first confirmed two-failure regression; otherwise 'held' once the window
 * elapses. A probe that throws is treated as a failure sample — an app we can't
 * reach after a deploy is exactly what the window exists to catch — but still
 * needs a second consecutive failure to trigger, so a single flaky probe is
 * never a rollback.
 */
export async function observeDeploy(deps: ObserveDeps): Promise<ObserveResult> {
  let state = OBSERVE_FRESH;
  const start = deps.now();

  while (deps.now() - start < deps.windowMs) {
    let result: ProbeResult;
    try {
      result = await deps.probe();
    } catch {
      result = { up: false, latencyMs: 0, detail: "couldn't reach the app after the deploy" };
    }

    const step = stepObservation(state, result);
    state = step.state;

    if (step.broke) {
      await deps.rollback();
      return { outcome: 'broke', rolledBack: true, samples: state.samples };
    }

    await deps.sleep(deps.intervalMs);
  }

  return { outcome: 'held', rolledBack: false, samples: state.samples };
}

/**
 * Fold an observation outcome into the final verdict. A change that broke prod
 * DID NOT work, whatever its pre-deploy checks said — and we own the miss out
 * loud (Ironclad 2). Holding leaves the pre-deploy verdict untouched: surviving
 * the window proves it didn't break the app, not that it did what was asked, so
 * a `probably` stays `probably`.
 */
export function verdictAfterObservation(
  preVerdict: VerifyVerdict,
  observed: ObserveResult,
): { verdict: VerifyVerdict; summary: string } {
  if (observed.outcome === 'broke') {
    return {
      verdict: 'didnt_work',
      summary: 'It went live and then broke the app, so I rolled it straight back. Nothing is left running from this change.',
    };
  }
  return {
    verdict: preVerdict,
    summary:
      preVerdict === 'verified'
        ? 'Verified — it did what you asked, and it held after going live.'
        : "Probably working — it held after going live and nothing I could check broke, though I couldn't fully confirm the change itself.",
  };
}
