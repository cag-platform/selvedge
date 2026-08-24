import { and, eq, gte, lt, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { narrations, trustIncidents } from '../db/schema/index.js';

// A real negative signal contradicts a prior all-clear if it lands within this
// window of a "users are fine" narration on the same project.
const CONTRADICTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Event types that MEAN users are affected, by the row's own definition.
 *
 * TWO WERE HERE THAT DO NOT, and together they made the ledger incoherent.
 * `deploy.failed_previous_serving` means the previous version is still
 * serving — its own template says "users are fine" — so every routine failed
 * deploy after an all-clear was recorded as the all-clear having been WRONG,
 * when it was still true. And `data.migration_failed` narrates as cannot_tell:
 * not knowing whether users are affected is not proof that they were, and a
 * ledger that counts "I could not tell" as "I got it wrong" is confessing to
 * sins it did not commit. That is how an account with nothing shipped came to
 * show 111 wrong all-clears — a number so obviously wrong it made the whole
 * honesty ledger read as noise, which costs the one thing the ledger exists
 * to buy.
 */
/**
 * THE RULE THAT KEEPS THE SET HONEST, and the safeguard against this bug's
 * return: an event may sit in HARD_NEGATIVE_EVENTS only if its OWN NARRATION
 * TEMPLATE carries verdict users_affected. Not "sounds negative", not "failed
 * is in the name" — the template is where the product already decided, once,
 * what each row means for users, and this set must never contradict it.
 *
 * test/trust/tripwire.test.ts enforces this structurally: it narrates every
 * member and fails if any narration says anything but users_affected. That is
 * also why `data.integrity_signal` left the set alongside the two that caused
 * the 111: it has no template at all, so its membership was a claim nothing
 * could check.
 *
 * (Exported for that test, not for callers — the door in is
 * isContradictingSignal.)
 */
export const HARD_NEGATIVE_EVENTS: ReadonlySet<string> = new Set([
  'runtime.health_failing',
  'deploy.failed_nothing_serving',
  'runtime.error_rate_spike',
]);

/**
 * What actually happened, in the owner's language. The detail used to
 * interpolate the raw event type — "then runtime.health_failing contradicted
 * it" — which is a machine name in the one sentence whose entire job is owning
 * a mistake plainly.
 */
const CONTRADICTION_SAID: Record<string, string> = {
  'runtime.health_failing': 'the app stopped answering',
  'deploy.failed_nothing_serving': 'a failed deploy left nothing running',
  'runtime.error_rate_spike': 'errors spiked for the people using it',
};

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
    detail: `I told you users were fine, and within a day ${CONTRADICTION_SAID[sig.eventType] ?? 'a real problem reached them'}.`,
  });
  return true;
}
