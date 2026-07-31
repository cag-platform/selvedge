import type { NewSelvedgeEvent } from '../../shared/types/event.js';
import type { ProbeResult } from './probe.js';

/**
 * The health-monitor decision core — pure, so the debounce is testable without
 * network or DB. Ported from toile's poller logic, reshaped to emit Selvedge
 * events instead of writing a status column and paging.
 *
 * Toile's two truths, both kept:
 *   1. The two-failure debounce. A single failed probe does NOT declare the app
 *      down — a blip that clears on the next poll never fires an event.
 *      `runtime.health_failing` fires exactly once, on the transition to the
 *      SECOND consecutive failure (edge-triggered), never again while it stays
 *      down.
 *   2. Recovery is only meaningful after a real failure. `runtime.recovered`
 *      fires only when a check that had actually alerted comes back up — never
 *      as a "recovery" from a state we never announced.
 *
 * The false-calm rule holds here too: the count only ever advances on a
 * confirmed failed probe, so an app is never announced down on a single flake,
 * and never announced recovered unless it was announced down first.
 */

export type HealthState = {
  /** Consecutive failed probes. */
  consecutiveFailures: number;
  /** Whether we have emitted health_failing for the current outage. */
  alerted: boolean;
};

export const HEALTHY: HealthState = { consecutiveFailures: 0, alerted: false };

/** How many consecutive failures before we announce an outage. Toile's value. */
export const FAILURE_THRESHOLD = 2;

export type HealthEventContext = {
  orgId: string;
  /** The app's source account id (repo full name) for continuity with other events. */
  sourceAccountId: string;
  /** A stable id for this check, for the dedupe key. */
  checkId: string;
  occurredAt: string;
};

export type HealthStep = { state: HealthState; event: NewSelvedgeEvent | null };

/**
 * Advance the debounce state by one probe result and decide what to emit.
 * Returns the new state (the caller persists it) and an event, or null.
 */
export function stepHealth(prev: HealthState, result: ProbeResult, ctx: HealthEventContext): HealthStep {
  const base = {
    org_id: ctx.orgId,
    source: 'railway' as const, // health probes ride the host source; refined by resolution
    source_account_id: ctx.sourceAccountId,
    occurred_at: ctx.occurredAt,
  };

  if (result.up) {
    // Recovery is only news if we had actually announced this outage.
    if (prev.alerted) {
      return {
        state: HEALTHY,
        event: {
          ...base,
          event_type: 'runtime.recovered',
          severity_hint: 'info',
          raw: { latencyMs: result.latencyMs },
          dedupe_key: `health:${ctx.checkId}:recovered:${ctx.occurredAt}`,
        },
      };
    }
    // Up, and we never announced anything — just clear any partial failure count.
    return { state: HEALTHY, event: null };
  }

  // A failed probe. Advance the count.
  const consecutiveFailures = prev.consecutiveFailures + 1;

  // Announce the outage exactly once, on crossing the threshold.
  if (!prev.alerted && consecutiveFailures >= FAILURE_THRESHOLD) {
    return {
      state: { consecutiveFailures, alerted: true },
      event: {
        ...base,
        event_type: 'runtime.health_failing',
        severity_hint: 'error',
        raw: { consecutiveFailures, detail: result.detail },
        dedupe_key: `health:${ctx.checkId}:failing:${ctx.occurredAt}`,
      },
    };
  }

  // Below threshold, or already announced — advance the count, emit nothing.
  return { state: { consecutiveFailures, alerted: prev.alerted }, event: null };
}
