import type { Db } from '../../db/client.js';
import type { NewSelvedgeEvent } from '../../../shared/types/event.js';
import type { HostDeployStatus, RailwayTarget } from './client.js';
import { getDeployState } from './client.js';
import { deployStateToEvent } from './deployEvents.js';

/**
 * The Railway deploy poller — the running mechanism that turns real host state
 * into events, replacing the GitHub "workflow name contains deploy" guess
 * (BUILD-BRIEF Phase 2). Edge-triggered: it holds the last state per service
 * and emits an event only on a change, via the pure mapper in deployEvents.ts.
 *
 * Everything external is injected so the whole poller is testable without the
 * network: the service list, the state read, the clock, and the ingest sink.
 * The last-state map is in-process — a documented single-process tradeoff
 * inherited from toile's monitor; a restart starts fresh, and first sight of a
 * service after a restart is handled correctly (no phantom recovery).
 *
 * A service we can't read this tick resolves to 'unknown', which the mapper
 * turns into no event (losing sight is not a failure) while still recording
 * "we don't currently know" so the next real reading is treated as first sight.
 */

export type ServiceToPoll = {
  orgId: string;
  target: RailwayTarget;
  token: string;
  /** GitHub repo full name for source_account_id continuity with build events. */
  repoFullName: string;
};

export type DeployPollDeps = {
  db: Db;
  /** Which services to check this tick — real impl reads packs with a railway source + resolved token. */
  listServices: () => Promise<ServiceToPoll[]>;
  /** Read a service's normalized deploy state. Defaults to the live client. */
  getState?: (token: string, target: RailwayTarget) => Promise<{ status: HostDeployStatus } | null>;
  /** Where emitted events go. Real impl is a thin wrapper over ingestEvent. */
  ingest: (event: NewSelvedgeEvent) => Promise<void>;
  /** The per-service last-known state, held across ticks by the caller. */
  lastState: Map<string, HostDeployStatus>;
  now?: () => Date;
};

/** One poll tick over all services. Returns the events emitted, for observability and tests. */
export async function pollDeployStates(deps: DeployPollDeps): Promise<NewSelvedgeEvent[]> {
  const read = deps.getState ?? getDeployState;
  const now = deps.now ?? (() => new Date());
  const emitted: NewSelvedgeEvent[] = [];

  const services = await deps.listServices();
  for (const svc of services) {
    const key = svc.target.serviceId;
    const prev = deps.lastState.get(key) ?? null;

    let current: HostDeployStatus;
    try {
      const state = await read(svc.token, svc.target);
      current = state?.status ?? 'unknown';
    } catch {
      current = 'unknown'; // a read failure is "can't tell", not a deploy failure
    }

    const event = deployStateToEvent(prev, current, {
      orgId: svc.orgId,
      repoFullName: svc.repoFullName,
      serviceId: svc.target.serviceId,
      occurredAt: now().toISOString(),
    });

    // Record what we now know (including 'unknown') so the next tick compares
    // against the truth, not a stale last-good.
    deps.lastState.set(key, current);

    if (event) {
      await deps.ingest(event);
      emitted.push(event);
    }
  }

  return emitted;
}
