import { ulid } from 'ulid';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, narrations } from '../db/schema/index.js';
import type { NewSelvedgeEvent } from '../../shared/types/event.js';
import type { ContextPack } from '../../shared/types/pack.js';
import { getPack } from '../packs/store.js';
import { resolveProjectId } from './resolveProject.js';
import { refineEventType } from './refineEventType.js';
import { updatePackState } from './updatePackState.js';
import { currentLocalTime, pairedOutagePushed, recentPushWorthyCount } from './routingContext.js';
import { route } from '../routing/route.js';
import { narrateDispatch, type NarrationDeps } from '../narration/dispatch.js';
import { classifyRow } from '../narration/classify.js';
import { extractSignature } from './knownFlaky.js';
import { correlateChange, isBreakEvent, CORRELATION_WINDOW_MS, type Correlation } from './correlate.js';
import { fusionForChange } from '../fusion/resolve.js';
import { proposeIncidentCard } from '../cards/incident.js';
import { recordFalseAllClearIfContradicted } from '../trust/tripwire.js';
import type { PushSender } from '../push/types.js';
import { sendToOrgDevices } from '../push/send.js';
import { criticalNotification } from '../push/notifications.js';

export type IngestResult = {
  eventId: string;
  duplicate: boolean;
  projectId: string | null;
  routeRowId: string | null;
  delivery: 'NONE' | 'DIGEST' | 'PUSH' | null;
};

/** Inserts the event row; returns null if this was a duplicate delivery (dedupe_key already seen for this org+timestamp). */
async function insertEvent(db: Db, id: string, receivedAt: Date, projectId: string | null, event: NewSelvedgeEvent) {
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
      changeRefs: event.change_refs ?? null,
      dedupeKey: event.dedupe_key,
    })
    .onConflictDoNothing({ target: [events.orgId, events.dedupeKey, events.occurredAt] })
    .returning({ id: events.id });
  return rows.length > 0;
}

/**
 * For a break event, line it up against the change that came just before it on
 * the same project's timeline. Reads only the change events in the window (the
 * partitioned events table is indexed by org+project), then defers the choice
 * and the wording to the pure correlateChange. Returns null for non-break
 * events and when nothing shipped in the window — no fabricated culprit.
 */
async function correlationFor(
  db: Db,
  orgId: string,
  projectId: string,
  eventType: string,
  occurredAt: Date,
): Promise<Correlation | null> {
  if (!isBreakEvent(eventType)) return null;

  const windowStart = new Date(occurredAt.getTime() - CORRELATION_WINDOW_MS);
  const rows = await db
    .select({ id: events.id, eventType: events.eventType, occurredAt: events.occurredAt })
    .from(events)
    .where(
      and(
        eq(events.orgId, orgId),
        eq(events.projectId, projectId),
        gte(events.occurredAt, windowStart),
        lt(events.occurredAt, occurredAt),
      ),
    );

  return correlateChange(
    eventType,
    occurredAt,
    rows.map((r) => ({ eventId: r.id, eventType: r.eventType, occurredAt: r.occurredAt as Date })),
  );
}

async function routeNarrateAndPersist(
  db: Db,
  orgId: string,
  projectId: string,
  pack: ContextPack,
  id: string,
  event: NewSelvedgeEvent,
  narrationDeps?: NarrationDeps,
  pushSender?: PushSender,
) {
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

  // Phase 2: the narration boundary. narrateDispatch honors intended_path
  // (TEMPLATE/LIB/LLM/LLM+VERDICT) when deps are provided and falls back to
  // the Phase 1 template on any model failure; with no deps it IS the
  // Phase 1 template path.
  const dispatched = await narrateDispatch(
    {
      id,
      org_id: orgId,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      severity_hint: event.severity_hint,
      ...(extractSignature(event.raw) ? { signature: extractSignature(event.raw) } : {}),
    },
    pack,
    decision,
    narrationDeps,
  );

  if (decision.delivery !== 'NONE' && dispatched) {
    const narrationId = ulid();
    // Change→break correlation: for a break event, find the change that came
    // just before it on this project's timeline. Stored on the narration so the
    // Today surface can show "started right after…" as a lead — never woven into
    // the verdict sentence, because it's correlation, not confirmed cause.
    const correlation = await correlationFor(db, orgId, projectId, event.event_type, new Date(event.occurred_at));
    // Fusion: from the correlated change to the WORK behind it — the thread or
    // the terminal session whose commit this was. Null far more often than not,
    // and that is the point: no session named on the commits, no story. A
    // failure here must never sink an ingest, so it degrades to no sentence.
    const fusion = correlation
      ? await fusionForChange(db, orgId, correlation.changeEventId, new Date(event.occurred_at)).catch((err) => {
          console.error(`fusion failed for ${orgId}/${projectId}:`, err);
          return null;
        })
      : null;
    await db.insert(narrations).values({
      id: narrationId,
      orgId,
      projectId,
      eventId: id,
      eventType: event.event_type,
      occurredAt: new Date(event.occurred_at),
      path: dispatched.path,
      intendedPath: decision.intended_path,
      delivery: decision.delivery,
      kind: classifyRow(decision.row_id),
      fragment: dispatched.output.fragment,
      technicalDetail: dispatched.output.technicalDetail ?? null,
      verdict: dispatched.output.verdict ?? null,
      confidence: dispatched.meta.confidence ?? null,
      meta: {
        modifiers: decision.modifiers,
        row_id: decision.row_id,
        ...dispatched.meta,
        ...(correlation ? { correlation } : {}),
        ...(fusion ? { fusion } : {}),
      },
    });

    // The unforgivable-error tripwire (Ironclad 2): if this narration is a
    // real negative signal (users_affected, or a health-failing event),
    // check whether we recently told this project's owner everything was fine
    // — and if so, log the miss so a correction brief can own it out loud.
    if (projectId) {
      await recordFalseAllClearIfContradicted(db, orgId, projectId, {
        narrationId,
        eventId: id,
        eventType: event.event_type,
        verdict: dispatched.output.verdict ?? null,
        occurredAt: new Date(event.occurred_at),
      });
    }

    // Immediate critical push: routing already decided this is PUSH-worthy
    // (with push_threshold + quiet-hours applied), and the fragment is
    // verdict-first. Deliver it to the owner's devices now.
    if (decision.delivery === 'PUSH' && pushSender && dispatched.output.fragment) {
      await sendToOrgDevices(db, orgId, pushSender, criticalNotification(dispatched.output.fragment, projectId)).catch((err) =>
        console.error(`critical push failed for org ${orgId}:`, err),
      );
    }
  }

  // Incident trigger (Phase 3): a break event proactively proposes a fix card,
  // deduped to one open card per project. Fires on the event itself, not the
  // narration, so it's independent of delivery. Best-effort — a card failure
  // must never break event ingestion.
  if (isBreakEvent(event.event_type)) {
    await proposeIncidentCard(db, orgId, projectId, pack, event.event_type, now).catch((err) =>
      console.error(`incident card proposal failed for org ${orgId}:`, err),
    );
  }

  return decision;
}

/**
 * The connector→resolution entrypoint. Resolves project_id via pack
 * topology, stores the (deduped) event, and — if resolved — rolls it
 * through refinement, pack state, routing, and narration.
 */
export async function ingestEvent(
  db: Db,
  event: NewSelvedgeEvent,
  narrationDeps?: NarrationDeps,
  pushSender?: PushSender,
): Promise<IngestResult> {
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
  const refinedEvent: NewSelvedgeEvent = { ...event, event_type: refinedType };

  const decision = await routeNarrateAndPersist(db, event.org_id, projectId, pack, id, refinedEvent, narrationDeps, pushSender);

  return { eventId: id, duplicate: false, projectId, routeRowId: decision.row_id, delivery: decision.delivery };
}

/**
 * For events resolution itself synthesizes for a project it already knows
 * (the stall sweep's code.branch_stalled, for example) — skips project
 * resolution and event_type refinement, both of which only make sense for
 * connector-sourced events.
 */
export async function ingestResolvedEvent(
  db: Db,
  projectId: string,
  event: NewSelvedgeEvent,
  narrationDeps?: NarrationDeps,
): Promise<IngestResult> {
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

  const decision = await routeNarrateAndPersist(db, event.org_id, projectId, pack, id, event, narrationDeps);
  return { eventId: id, duplicate: false, projectId, routeRowId: decision.row_id, delivery: decision.delivery };
}
