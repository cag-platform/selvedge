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
export async function onPlan(
  db: { insert: (t: typeof subscriptions) => { values: (v: typeof subscriptions.$inferInsert) => Promise<unknown> } },
  orgId: string,
  plan: PlanId = 'pro',
  opts: { status?: SubscriptionStatus; currentPeriodEnd?: Date } = {},
): Promise<void> {
  await db.insert(subscriptions).values({
    id: ulid(),
    orgId,
    plan,
    status: opts.status ?? 'active',
    ...(opts.currentPeriodEnd ? { currentPeriodEnd: opts.currentPeriodEnd } : {}),
  });
}
