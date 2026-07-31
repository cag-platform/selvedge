import type { NewSelvedgeEvent } from '../../shared/types/event.js';

/**
 * The error-rate spike detector — the producer for `runtime.error_rate_spike`,
 * the last Group-C runtime event with a route but no source (BUILD-BRIEF
 * Phase 2: "Error ingest"). Pure, so the whole baseline-and-debounce decision
 * is testable without a network, a DB, or a clock.
 *
 * Same discipline as the health monitor, applied to a rate instead of an
 * up/down probe:
 *
 *   1. No baseline, no verdict. Until we've watched enough windows to know what
 *      "normal" looks like for this app, we NEVER announce a spike — a fresh app
 *      is silent, not falsely calm and not falsely alarmed. Warming up is a
 *      distinct state from "fine": we simply don't speak yet.
 *   2. The two-window debounce. A single elevated window does NOT declare a
 *      spike — one bad minute that clears on the next window never fires.
 *      `runtime.error_rate_spike` fires exactly once, on the transition to the
 *      SECOND consecutive elevated window (edge-triggered), never again while it
 *      stays elevated.
 *   3. A spike never becomes the new normal. Once warmed, the baseline only
 *      learns from non-elevated windows, so a sustained outage can't silently
 *      raise the bar until it stops looking like a problem (the boiling-frog
 *      failure).
 *   4. An absolute floor. No matter how low the baseline, a rate below the floor
 *      is never a spike — a jump from 0.1% to 0.4% errors is 4× but still fine,
 *      and the owner should not be paged for it.
 *
 * There is no "error rate recovered" event: the routing table has no such row,
 * and a rate quietly returning to normal is not news. Recovery clears the
 * alerted flag silently so the NEXT genuine spike can fire.
 *
 * `rate` is a dimensionless error fraction in [0, 1] — errors ÷ requests over
 * the window — so the floor and multiplier mean the same thing for every app,
 * whatever its traffic. The transport that produces it (a log tail, an error
 * connector, or an inbound beacon) is injected by the poller and deferred, just
 * as the Railway deploy poller's real service discovery is.
 */

export type ErrorRateSample = {
  /** Error fraction over the window, in [0, 1] (errors ÷ requests). */
  rate: number;
  /** When the window began, for the raw record and dedupe continuity. */
  windowStartedAt: string;
};

export type ErrorRateState = {
  /** EWMA of observed non-elevated rates; null until the first sample warms it. */
  baseline: number | null;
  /** How many real windows we've folded in — the warm-up gate. */
  windowsSeen: number;
  /** Consecutive elevated windows observed right now. */
  consecutiveElevated: number;
  /** Whether we've already announced the current spike. */
  alerted: boolean;
};

export const FRESH: ErrorRateState = { baseline: null, windowsSeen: 0, consecutiveElevated: 0, alerted: false };

/** Windows to watch before we trust the baseline enough to call anything a spike. */
export const WARMUP_WINDOWS = 5;
/** A window counts as elevated only at or above this multiple of the baseline. */
export const SPIKE_MULTIPLIER = 3;
/** …and never below this absolute error fraction, whatever the baseline (5%). */
export const MIN_FLOOR = 0.05;
/** How fast the baseline tracks reality. */
const EWMA_ALPHA = 0.3;

export type ErrorEventContext = {
  orgId: string;
  /** The app's source account id (repo full name) for continuity with other events. */
  sourceAccountId: string;
  /** A stable id for this error source, for the dedupe key. */
  sourceId: string;
  occurredAt: string;
};

export type ErrorRateStep = { state: ErrorRateState; event: NewSelvedgeEvent | null };

/** Fold a new observed rate into the baseline. */
function updateBaseline(baseline: number | null, rate: number): number {
  return baseline == null ? rate : EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * baseline;
}

/**
 * Advance the detector by one observed window and decide what to emit. Returns
 * the new state (the caller persists it) and an event, or null. A window we
 * could NOT observe is not passed here at all — the poller skips it — so this
 * only ever sees real samples.
 */
export function stepErrorRate(prev: ErrorRateState, sample: ErrorRateSample, ctx: ErrorEventContext): ErrorRateStep {
  const warmed = prev.windowsSeen >= WARMUP_WINDOWS;
  const elevated =
    warmed && prev.baseline != null && sample.rate >= MIN_FLOOR && sample.rate >= prev.baseline * SPIKE_MULTIPLIER;

  if (!elevated) {
    // Normal window: learn from it, reset the run, and clear any prior alert
    // silently (a rate returning to normal is not itself news).
    return {
      state: {
        baseline: updateBaseline(prev.baseline, sample.rate),
        windowsSeen: prev.windowsSeen + 1,
        consecutiveElevated: 0,
        alerted: false,
      },
      event: null,
    };
  }

  // Elevated. Advance the run, but do NOT let it move the baseline — a spike
  // must never become the new normal.
  const consecutiveElevated = prev.consecutiveElevated + 1;

  if (!prev.alerted && consecutiveElevated >= 2) {
    return {
      state: { baseline: prev.baseline, windowsSeen: prev.windowsSeen + 1, consecutiveElevated, alerted: true },
      event: {
        org_id: ctx.orgId,
        source: 'railway', // errors ride the host source; refined by resolution, like health probes
        source_account_id: ctx.sourceAccountId,
        occurred_at: ctx.occurredAt,
        event_type: 'runtime.error_rate_spike',
        severity_hint: 'error',
        raw: {
          rate: sample.rate,
          baseline: prev.baseline,
          multiple: prev.baseline ? sample.rate / prev.baseline : null,
          windowStartedAt: sample.windowStartedAt,
        },
        dedupe_key: `errorrate:${ctx.sourceId}:spike:${ctx.occurredAt}`,
      },
    };
  }

  // First elevated window, or already announced — advance, emit nothing.
  return {
    state: { baseline: prev.baseline, windowsSeen: prev.windowsSeen + 1, consecutiveElevated, alerted: prev.alerted },
    event: null,
  };
}
