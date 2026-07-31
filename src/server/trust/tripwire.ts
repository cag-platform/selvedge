import { and, eq, gte, lt, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { narrations, trustIncidents } from '../db/schema/index.js';

// A real negative signal contradicts a prior all-clear if it lands within this
// window of a "users are fine" narration on the same project.
const CONTRADICTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Event types that are, by themselves, a hard negative (independent of a
// verdict phrase) — a health failure or a failed deploy on live serving.
const HARD_NEGATIVE_EVENTS = new Set([
  'runtime.health_failing',
  'deploy.failed_previous_serving',
  'deploy.failed_nothing_serving',
  'data.migration_failed',
  'runtime.error_rate_spike',
  'data.integrity_signal',
]);

export type ContradictingSignal = {
  narrationId: string;
  eventId: string;
  eventType: string;
  verdict: string | null;
  occurredAt: Date;
};

export function isContradictingSignal(sig: Pick<ContradictingSignal, 'eventType' | 'verdict'>): boolean {
  return sig.verdict === 'users_affected' || HARD_NEGATIVE_EVENTS.has(sig.eventType);
}

/**
 * The Ironclad-2 tripwire. When a genuine negative signal lands, look back for
 * a recent "users are fine" narration on the same project; if one exists, we
 * told the owner everything was okay and it wasn't — the one unforgivable
 * output. Record a Class-1 honesty-ledger incident so a correction brief can
 * own the miss. Returns true if an incident was recorded.
 */
export async function recordFalseAllClearIfContradicted(
  db: Db,
  orgId: string,
  projectId: string,
  sig: ContradictingSignal,
): Promise<boolean> {
  if (!isContradictingSignal(sig)) return false;

  const windowStart = new Date(sig.occurredAt.getTime() - CONTRADICTION_WINDOW_MS);
  const [prior] = await db
    .select({ id: narrations.id })
    .from(narrations)
    .where(
      and(
        eq(narrations.orgId, orgId),
        eq(narrations.projectId, projectId),
        eq(narrations.verdict, 'users_fine'),
        gte(narrations.occurredAt, windowStart),
        lt(narrations.occurredAt, sig.occurredAt),
      ),
    )
    .orderBy(desc(narrations.occurredAt))
    .limit(1);

  if (!prior) return false;

  await db.insert(trustIncidents).values({
    id: ulid(),
    orgId,
    projectId,
    kind: 'false_all_clear',
    priorNarrationId: prior.id,
    contradictingEventId: sig.eventId,
    detail: `Told you users were fine, then ${sig.eventType} contradicted it within 24 hours.`,
  });
  return true;
}
