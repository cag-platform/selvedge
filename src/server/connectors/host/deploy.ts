import type { ConnectorKind, NewSelvedgeEvent } from '../../../shared/types/event.js';

/**
 * Host-generic deploy types and the pure state→event mapper, shared by every
 * host connector (Railway, Vercel, …). The normalized status vocabulary and the
 * false-calm rules live here once, so a second host is a thin client plus a
 * status map — never a re-implementation of "is this deploy fine".
 *
 * The false-calm rule, applied to deploys twice over:
 *   - A transition INTO 'unknown' emits NOTHING. Losing sight of a service is
 *     not a failure; fabricating one from "can't tell" is the confidently-wrong
 *     move the product forbids.
 *   - A transition OUT OF 'unknown' into a real state is treated as first sight,
 *     not a change from a state we never knew — so coming back and finding it
 *     'live' does not manufacture a phantom recovery.
 */

/** The normalized deploy state Selvedge reasons about, whatever the host calls it. */
export type HostDeployStatus = 'live' | 'building' | 'failed' | 'unknown';

export type DeployEventContext = {
  orgId: string;
  /** Which host produced this — the event's source. */
  source: ConnectorKind;
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
    source: ctx.source,
    source_account_id: ctx.repoFullName,
    occurred_at: ctx.occurredAt,
    raw: { prev, current, serviceId: ctx.serviceId, host: ctx.source },
  };

  // A change into a real state reports that state. We deliberately do NOT
  // synthesize a "recovery" on first sight — coming back to find a service live
  // is not proof it had been down; runtime recovery events come from the health
  // monitor, which actually watched it.
  switch (current) {
    case 'building':
      return { ...base, event_type: 'build.started', severity_hint: 'info', dedupe_key: `${ctx.source}:${ctx.serviceId}:building:${ctx.occurredAt}` };
    case 'live':
      return { ...base, event_type: 'build.succeeded', severity_hint: 'info', dedupe_key: `${ctx.source}:${ctx.serviceId}:live:${ctx.occurredAt}` };
    case 'failed':
      return {
        ...base,
        // Provisional; resolution upgrades to nothing_serving from the pack.
        event_type: 'deploy.failed_previous_serving',
        severity_hint: 'error',
        dedupe_key: `${ctx.source}:${ctx.serviceId}:failed:${ctx.occurredAt}`,
      };
  }
}
