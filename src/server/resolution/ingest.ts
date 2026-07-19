import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { events, narrations } from '../db/schema/index.js';
import type { NewSiltaEvent } from '../../shared/types/event.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { getPack } from '../packs/store.js';
import { resolveProjectId } from './resolveProject.js';
import { refineEventType } from './refineEventType.js';
import { updatePackState } from './updatePackState.js';
import { currentLocalTime, pairedOutagePushed, recentPushWorthyCount } from './routingContext.js';
import { route } from '../routing/route.js';
import { narrate } from '../narration/narrate.js';

export type IngestResult = {
  eventId: string;
  duplicate: boolean;
  projectId: string | null;
  routeRowId: string | null;
  delivery: 'NONE' | 'DIGEST' | 'PUSH' | null;
};

/** Inserts the event row; returns null if this was a duplicate delivery (dedupe_key already seen for this org+timestamp). */
async function insertEvent(db: Db, id: string, receivedAt: Date, projectId: string | null, event: NewSiltaEvent) {
  const rows = await db
    .insert(events)
    .values({
      id,
      orgId: event.org_id,
      source: event.source,
      sourceAccountId: event.source_account_id,
      projectId,
      eventType: event.event_type,
      occurredAt: new Date(event.occurred_at),
      receivedAt,
      severityHint: event.severity_hint,
      raw: event.raw,
      dedupeKey: event.dedupe_key,
    })
    .onConflictDoNothing({ target: [events.orgId, events.dedupeKey, events.occurredAt] })
    .returning({ id: events.id });
  return rows.length > 0;
}

async function routeNarrateAndPersist(db: Db, orgId: string, projectId: string, pack: ContextPack, id: string, event: NewSiltaEvent) {
  const now = new Date();
  const context: Parameters<typeof route>[2] = {
    now,
    currentLocalTime: await currentLocalTime(db, orgId, now),
    recentPushWorthyCount: await recentPushWorthyCount(db, orgId, projectId, now),
  };
  if (event.event_type === 'runtime.recovered') {
    context.pairedOutagePushed = await pairedOutagePushed(db, orgId, projectId);
  }

  const decision = route({ event_type: event.event_type }, pack, context);

  await updatePackState(db, orgId, projectId, event.source, event.event_type, event.occurred_at);

  const output = narrate(
    { id, event_type: event.event_type, occurred_at: event.occurred_at, severity_hint: event.severity_hint },
    pack,
    decision,
  );

  if (decision.delivery !== 'NONE' && output) {
    await db.insert(narrations).values({
      id: ulid(),
      orgId,
      projectId,
      eventId: id,
      eventType: event.event_type,
      occurredAt: new Date(event.occurred_at),
      path: decision.path,
      intendedPath: decision.intended_path,
      delivery: decision.delivery,
      fragment: output.fragment,
      technicalDetail: output.technicalDetail ?? null,
      verdict: output.verdict ?? null,
      meta: { modifiers: decision.modifiers, row_id: decision.row_id },
    });
  }

  return decision;
}

/**
 * The connector→resolution entrypoint. Resolves project_id via pack
 * topology, stores the (deduped) event, and — if resolved — rolls it
 * through refinement, pack state, routing, and narration.
 */
export async function ingestEvent(db: Db, event: NewSiltaEvent): Promise<IngestResult> {
  const id = ulid();
  const receivedAt = new Date();
  const projectId = await resolveProjectId(db, event.org_id, event.source, event.source_account_id);

  const inserted = await insertEvent(db, id, receivedAt, projectId, event);
  if (!inserted) {
    return { eventId: id, duplicate: true, projectId, routeRowId: null, delivery: null };
  }

  if (!projectId) {
    return { eventId: id, duplicate: false, projectId: null, routeRowId: null, delivery: null };
  }

  const pack = await getPack(db, event.org_id, projectId);
  if (!pack) {
    // Shouldn't happen — resolveProjectId only returns a project_id backed
    // by an existing pack — but don't let a race turn into a crash.
    return { eventId: id, duplicate: false, projectId, routeRowId: null, delivery: null };
  }

  const refinedType = refineEventType(event.event_type, event.raw, pack);
  const refinedEvent: NewSiltaEvent = { ...event, event_type: refinedType };

  const decision = await routeNarrateAndPersist(db, event.org_id, projectId, pack, id, refinedEvent);

  return { eventId: id, duplicate: false, projectId, routeRowId: decision.row_id, delivery: decision.delivery };
}

/**
 * For events resolution itself synthesizes for a project it already knows
 * (the stall sweep's code.branch_stalled, for example) — skips project
 * resolution and event_type refinement, both of which only make sense for
 * connector-sourced events.
 */
export async function ingestResolvedEvent(db: Db, projectId: string, event: NewSiltaEvent): Promise<IngestResult> {
  const id = ulid();
  const receivedAt = new Date();

  const inserted = await insertEvent(db, id, receivedAt, projectId, event);
  if (!inserted) {
    return { eventId: id, duplicate: true, projectId, routeRowId: null, delivery: null };
  }

  const pack = await getPack(db, event.org_id, projectId);
  if (!pack) {
    return { eventId: id, duplicate: false, projectId, routeRowId: null, delivery: null };
  }

  const decision = await routeNarrateAndPersist(db, event.org_id, projectId, pack, id, event);
  return { eventId: id, duplicate: false, projectId, routeRowId: decision.row_id, delivery: decision.delivery };
}
