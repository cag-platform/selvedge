import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { NewSelvedgeEvent } from '../../shared/types/event.js';
import { healthChecks } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { ingestResolvedEvent } from '../resolution/ingest.js';
import { buildNarrationDeps } from '../llm/factory.js';
import type { CheckToPoll } from './poller.js';
import type { ProbeKind } from './probe.js';

/**
 * The live wiring that turns the monitor's proven loop into a running source:
 * real check discovery from the DB, and an ingest sink that carries each event
 * through the same per-org narration path a webhook event takes.
 *
 * Health and deploy events know their project directly (the check stores a
 * projectId), so they ingest via ingestResolvedEvent — skipping the
 * source→project resolution that only makes sense for connector-sourced
 * events, and which would otherwise depend on provisioning having written a
 * host source into the pack.
 */

/**
 * The ingest sink shared by both pollers. Resolves the event's org fuel and
 * ingests against the project the producer already identified — via
 * ingestResolvedEvent, so no source→project resolution is needed. The project
 * is passed explicitly by the poller, not smuggled inside the event.
 */
export function makePollerIngest(db: Db) {
  return async (event: NewSelvedgeEvent, projectId: string): Promise<void> => {
    const narrationDeps = await buildNarrationDeps(db, event.org_id ?? '');
    await ingestResolvedEvent(db, projectId, event, narrationDeps);
  };
}

/**
 * Discover the enabled health checks to poll, resolving each to the app's
 * source_account_id (its github repo, for event continuity) and carrying the
 * projectId so the ingest sink can place the event without source resolution.
 */
export async function listHealthChecksToPoll(db: Db): Promise<CheckToPoll[]> {
  const rows = await db.select().from(healthChecks).where(eq(healthChecks.enabled, true));
  const out: CheckToPoll[] = [];
  for (const row of rows) {
    const pack = await getPack(db, row.orgId, row.projectId);
    // Prefer the github source for continuity; fall back to the project id.
    const sourceAccountId =
      pack?.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? row.projectId;
    out.push({
      orgId: row.orgId,
      sourceAccountId,
      intervalSec: row.intervalSec,
      projectId: row.projectId,
      spec: {
        id: row.id,
        kind: row.kind as ProbeKind,
        url: row.url,
        expectedStatus: row.expectedStatus,
        keyword: row.keyword,
      },
    });
  }
  return out;
}

/** A single enabled health check for an org's project, for tests and seeding. */
export async function insertHealthCheck(
  db: Db,
  row: {
    id: string;
    orgId: string;
    projectId: string;
    kind: ProbeKind;
    url: string;
    expectedStatus?: number | null;
    keyword?: string | null;
    intervalSec?: number;
  },
): Promise<void> {
  await db.insert(healthChecks).values({
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    kind: row.kind,
    url: row.url,
    expectedStatus: row.expectedStatus ?? null,
    keyword: row.keyword ?? null,
    intervalSec: row.intervalSec ?? 60,
    enabled: true,
  });
}

/** Disable a check (used to prove discovery honours enabled). */
export async function disableHealthCheck(db: Db, orgId: string, id: string): Promise<void> {
  await db.update(healthChecks).set({ enabled: false }).where(and(eq(healthChecks.orgId, orgId), eq(healthChecks.id, id)));
}
