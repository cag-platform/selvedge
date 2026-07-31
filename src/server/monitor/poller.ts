import type { Db } from '../db/client.js';
import type { NewSelvedgeEvent } from '../../shared/types/event.js';
import { runCheck, type HealthCheckSpec, type ProbeResult } from './probe.js';
import { stepHealth, HEALTHY, type HealthState } from './healthEvents.js';

/**
 * The health monitor's running loop — the mechanism that turns probes into
 * runtime.health_failing / runtime.recovered events (BUILD-BRIEF Phase 2:
 * "port toile's monitor... Selvedge's runtime event types are already built
 * and routed, with no source producing them"). This is that source.
 *
 * Same shape as the Railway deploy poller: everything external is injected, so
 * the whole loop is testable without the network. The per-check debounce state
 * is held across ticks by the caller (in-process, the documented single-process
 * tradeoff from toile — a restart re-evaluates from a clean slate).
 *
 * A check runs only when its interval has elapsed, and never concurrently with
 * itself — the two guards toile used, preserved.
 */

export type CheckToPoll = {
  orgId: string;
  /** The project this check belongs to — passed to ingest so events place without source resolution. */
  projectId: string;
  sourceAccountId: string;
  intervalSec: number;
  spec: HealthCheckSpec & { id: string };
};

export type MonitorState = {
  health: Map<string, HealthState>;
  lastPolledAt: Map<string, number>;
  inFlight: Set<string>;
};

export function newMonitorState(): MonitorState {
  return { health: new Map(), lastPolledAt: new Map(), inFlight: new Set() };
}

export type MonitorPollDeps = {
  db: Db;
  listChecks: () => Promise<CheckToPoll[]>;
  probe?: (spec: HealthCheckSpec) => Promise<ProbeResult>;
  ingest: (event: NewSelvedgeEvent, projectId: string) => Promise<void>;
  state: MonitorState;
  now?: () => Date;
};

/** One monitor tick. Returns the events emitted this tick, for observability and tests. */
export async function pollHealth(deps: MonitorPollDeps): Promise<NewSelvedgeEvent[]> {
  const probe = deps.probe ?? runCheck;
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  const emitted: NewSelvedgeEvent[] = [];

  const checks = await deps.listChecks();
  for (const check of checks) {
    const id = check.spec.id;

    // Never double-run a check, and respect its interval.
    if (deps.state.inFlight.has(id)) continue;
    const last = deps.state.lastPolledAt.get(id) ?? 0;
    if (nowMs - last < check.intervalSec * 1000) continue;

    deps.state.inFlight.add(id);
    try {
      const result = await probe(check.spec);
      deps.state.lastPolledAt.set(id, now().getTime());

      const prev = deps.state.health.get(id) ?? HEALTHY;
      const step = stepHealth(prev, result, {
        orgId: check.orgId,
        sourceAccountId: check.sourceAccountId,
        checkId: id,
        occurredAt: now().toISOString(),
      });
      deps.state.health.set(id, step.state);

      if (step.event) {
        await deps.ingest(step.event, check.projectId);
        emitted.push(step.event);
      }
    } finally {
      deps.state.inFlight.delete(id);
    }
  }

  return emitted;
}
