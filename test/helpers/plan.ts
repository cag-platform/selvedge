import { ulid } from 'ulid';
import { subscriptions } from '../../src/server/db/schema/index.js';
import type { PlanId, SubscriptionStatus } from '../../src/shared/plans.js';

/**
 * Put a test org on a plan.
 *
 * Needed because a test database has no subscriptions in it, so every test org
 * is on Free — which is correct, and which means a test about a feature behind
 * the paywall has to say so out loud. That is the point: a test that quietly
 * assumed Pro would keep passing after someone moved the feature behind a
 * higher tier.
 */
type Insertable = {
  insert: (t: typeof subscriptions) => {
    values: (v: typeof subscriptions.$inferInsert) => {
      onConflictDoUpdate: (c: unknown) => Promise<unknown>;
    };
  };
};

/**
 * Moves an org BETWEEN plans as well as onto one, because a test that walks a
 * limit usually needs both — set up on Pro, then drop to Free to watch the
 * wall. Inserting twice hit the one-subscription-per-org index, which is the
 * right index and the wrong error to make a test author read.
 */
export async function onPlan(
  db: Insertable,
  orgId: string,
  plan: PlanId = 'pro',
  opts: { status?: SubscriptionStatus; currentPeriodEnd?: Date } = {},
): Promise<void> {
  const row = {
    plan,
    status: opts.status ?? 'active',
    ...(opts.currentPeriodEnd ? { currentPeriodEnd: opts.currentPeriodEnd } : {}),
  };
  await db
    .insert(subscriptions)
    .values({ id: ulid(), orgId, ...row })
    .onConflictDoUpdate({ target: subscriptions.orgId, set: row });
}
