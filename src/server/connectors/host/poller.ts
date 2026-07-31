import type { Db } from '../../db/client.js';
import type { ConnectorKind, NewSelvedgeEvent } from '../../../shared/types/event.js';
import type { HostDeployStatus } from '../host/deploy.js';
import { deployStateToEvent } from '../host/deploy.js';

/**
 * The deploy poller — the running mechanism that turns real host state into
 * events, replacing the GitHub "workflow name contains deploy" guess
 * (BUILD-BRIEF Phase 2). Host-agnostic: each service carries its own pre-bound
 * `read` and its `source`, so Railway and Vercel (and any future host) flow
 * through the one loop and the one pure mapper.
 *
 * Edge-triggered: it holds the last state per service and emits only on a
 * change. Everything external is injected, so the poller is testable without a
 * network. The last-state map is in-process — a documented single-process
 * tradeoff inherited from toile's monitor; a restart starts fresh, and first
 * sight after a restart is handled correctly (no phantom recovery).
 *
 * A service we can't read this tick resolves to 'unknown', which the mapper
 * turns into no event (losing sight is not a failure) while still recording
 * "we don't currently know" so the next real reading is treated as first sight.
 */

export type ServiceToPoll = {
  orgId: string;
  /** The project this service belongs to — passed to ingest so events place without source resolution. */
  projectId: string;
  /** Which host this service runs on — becomes the event source. */
  source: ConnectorKind;
  /** A stable id for this service: the last-state key and the dedupe key. */
  serviceId: string;
  /** GitHub repo full name for source_account_id continuity with build events. */
  repoFullName: string;
  /** Read this service's normalized state. Pre-bound with the host client + token + target. */
  read: () => Promise<{ status: HostDeployStatus } | null>;
};

export type DeployPollDeps = {
  db: Db;
  /** Which services to check this tick — real impl reads packs with a host source + resolved token. */
  listServices: () => Promise<ServiceToPoll[]>;
  /** Where emitted events go. Real impl is a thin wrapper over ingestEvent. */
  ingest: (event: NewSelvedgeEvent, projectId: string) => Promise<void>;
  /** The per-service last-known state, held across ticks by the caller. */
  lastState: Map<string, HostDeployStatus>;
  now?: () => Date;
};

/** One poll tick over all services. Returns the events emitted, for observability and tests. */
export async function pollDeployStates(deps: DeployPollDeps): Promise<NewSelvedgeEvent[]> {
  const now = deps.now ?? (() => new Date());
  const emitted: NewSelvedgeEvent[] = [];

  const services = await deps.listServices();
  for (const svc of services) {
    // Namespace the state key by host, so two hosts' service ids can't collide.
    const key = `${svc.source}:${svc.serviceId}`;
    const prev = deps.lastState.get(key) ?? null;

    let current: HostDeployStatus;
    try {
      const state = await svc.read();
      current = state?.status ?? 'unknown';
    } catch {
      current = 'unknown'; // a read failure is "can't tell", not a deploy failure
    }

    const event = deployStateToEvent(prev, current, {
      orgId: svc.orgId,
      source: svc.source,
      repoFullName: svc.repoFullName,
      serviceId: svc.serviceId,
      occurredAt: now().toISOString(),
    });

    // Record what we now know (including 'unknown') so the next tick compares
    // against the truth, not a stale last-good.
    deps.lastState.set(key, current);

    if (event) {
      await deps.ingest(event, svc.projectId);
      emitted.push(event);
    }
  }

  return emitted;
}
