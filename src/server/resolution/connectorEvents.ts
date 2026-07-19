import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { events, narrations } from '../db/schema/index.js';
import type { ConnectorKind } from '../../shared/types/event.js';
import { connectorAuthFailedNarration } from '../narration/orgLevel.js';

/**
 * E1/E4 (Group E, org-level) don't go through route()/narrate() — there's
 * no project pack to route against. Persists both the event (for the
 * audit trail / traceability, acceptance gate 2) and a narration row with
 * project_id null so it surfaces on the Today page ahead of the digest.
 */
async function recordOrgLevelNarration(
  db: Db,
  orgId: string,
  eventType: string,
  source: ConnectorKind,
  sourceAccountId: string,
  fragment: string,
  verdict: string | undefined,
  now: Date,
): Promise<void> {
  const eventId = ulid();
  await db.insert(events).values({
    id: eventId,
    orgId,
    source,
    sourceAccountId,
    projectId: null,
    eventType,
    occurredAt: now,
    receivedAt: now,
    severityHint: 'error',
    raw: {},
    dedupeKey: `orglevel:${orgId}:${eventType}:${sourceAccountId}:${now.toISOString()}`,
  });

  await db.insert(narrations).values({
    id: ulid(),
    orgId,
    projectId: null,
    eventId,
    eventType,
    occurredAt: now,
    path: 'TEMPLATE',
    intendedPath: 'TEMPLATE',
    delivery: 'PUSH',
    fragment,
    verdict: verdict ?? null,
  });
}

/**
 * E1: "the one event class that always pushes regardless of tier." Called
 * only on the fresh->auth_failed transition (webhook.ts checks connector
 * status first) so a broken secret doesn't spam a new narration on every
 * retried delivery.
 */
export async function recordConnectorAuthFailed(
  db: Db,
  orgId: string,
  connectorLabel: string,
  source: ConnectorKind,
  sourceAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  const output = connectorAuthFailedNarration(connectorLabel);
  await recordOrgLevelNarration(db, orgId, 'connector.auth_failed', source, sourceAccountId, output.fragment, output.verdict, now);
}
