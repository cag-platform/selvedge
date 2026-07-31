import type { NewSelvedgeEvent } from '../../../shared/types/event.js';
import type { HostDeployStatus } from './client.js';

/**
 * Turn a change in a host's real deploy state into a Selvedge event — the
 * Phase 2 replacement for the GitHub normalizer's "the workflow name contains
 * the word deploy" guess. The host knows whether a deploy actually went live
 * or failed; GitHub only knows a workflow finished.
 *
 * Edge-triggered: an event is emitted only on a state CHANGE, so a poll that
 * sees the same state twice is silent. The previous state is whatever we last
 * saw for this service (null the first time).
 *
 * The false-calm rule, applied to deploys twice over:
 *   - A transition INTO 'unknown' emits NOTHING. Losing sight of a service is
 *     not a failure; fabricating one from "can't tell" is exactly the
 *     confidently-wrong move the product forbids.
 *   - A transition OUT OF 'unknown' into a real state is treated as first
 *     sight, not as a change from a state we never actually knew — so coming
 *     back and finding it 'live' does not manufacture a phantom recovery.
 *
 * Deploy-failure events are emitted provisionally as `deploy.failed_previous_
 * serving`; the resolution layer already upgrades that to `..._nothing_serving`
 * from the pack when nothing has ever served, so that distinction stays in one
 * place rather than being re-derived here.
 */

export type DeployEventContext = {
  orgId: string;
  /** The GitHub repo full name this service deploys, for source_account_id continuity with build events. */
  repoFullName: string;
  /** A stable id for this service, for the dedupe key. */
  serviceId: string;
  occurredAt: string;
};

export function deployStateToEvent(
  prev: HostDeployStatus | null,
  current: HostDeployStatus,
  ctx: DeployEventContext,
): NewSelvedgeEvent | null {
  // No change → nothing to say.
  if (prev === current) return null;

  // Losing visibility is not an event. Never emit a failure from "can't tell".
  if (current === 'unknown') return null;

  const base = {
    org_id: ctx.orgId,
    source: 'railway' as const,
    source_account_id: ctx.repoFullName,
    occurred_at: ctx.occurredAt,
    raw: { prev, current, serviceId: ctx.serviceId },
  };

  // Whatever the previous state was (including a genuine first sight, where
  // prev is null or 'unknown'), a change into a real state reports that state.
  // We deliberately do NOT synthesize a "recovery" on first sight — coming
  // back to find a service live is not proof it had been down; runtime
  // recovery events come from the health monitor, which actually watched it.
  switch (current) {
    case 'building':
      return {
        ...base,
        event_type: 'build.started',
        severity_hint: 'info',
        dedupe_key: `railway:${ctx.serviceId}:building:${ctx.occurredAt}`,
      };

    case 'live':
      return {
        ...base,
        event_type: 'build.succeeded',
        severity_hint: 'info',
        dedupe_key: `railway:${ctx.serviceId}:live:${ctx.occurredAt}`,
      };

    case 'failed':
      return {
        ...base,
        // Provisional; resolution upgrades to nothing_serving from the pack.
        event_type: 'deploy.failed_previous_serving',
        severity_hint: 'error',
        dedupe_key: `railway:${ctx.serviceId}:failed:${ctx.occurredAt}`,
      };
  }
}
