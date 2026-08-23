import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { stripeEvents, subscriptions } from '../db/schema/index.js';
import type { BillingInterval, PlanId, SubscriptionStatus } from '../../shared/plans.js';

/**
 * READING AND WRITING WHAT WAS BOUGHT.
 *
 * Every write here is an UPSERT KEYED ON THE ORG, and every lookup a webhook
 * makes is keyed on the STRIPE CUSTOMER. That pairing is deliberate: a webhook
 * can arrive before the owner's browser gets back from Checkout, so the handler
 * cannot rely on anything the app knows about the session. It only ever needs
 * the customer id, which we create and store before the redirect.
 */

export type SubscriptionRecord = {
  id: string;
  orgId: string;
  boughtByUserId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: PlanId;
  status: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  grandfatheredPrice: boolean;
  currentPeriodEnd: Date | null;
};

function asRecord(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    boughtByUserId: row.boughtByUserId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    plan: row.plan as PlanId,
    status: row.status as SubscriptionStatus,
    billingInterval: (row.billingInterval as BillingInterval | null) ?? null,
    grandfatheredPrice: row.grandfatheredPrice,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

export async function subscriptionForOrg(db: Db, orgId: string): Promise<SubscriptionRecord | null> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).limit(1);
  return row ? asRecord(row) : null;
}

/** How a webhook finds its way home. The customer id is the only thing every event carries. */
export async function subscriptionForCustomer(db: Db, customerId: string): Promise<SubscriptionRecord | null> {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, customerId)).limit(1);
  return row ? asRecord(row) : null;
}

export type SubscriptionPatch = Partial<{
  boughtByUserId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: PlanId;
  status: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  grandfatheredPrice: boolean;
  currentPeriodEnd: Date | null;
}>;

/**
 * Write what we now know about an org's subscription, creating the row if this
 * is the first thing we have ever known.
 *
 * Only the fields actually passed are written. That matters for replay: an
 * `invoice.paid` says nothing about which price is on the subscription, and a
 * handler that wrote its whole idea of the world each time would blank the
 * interval every renewal.
 */
export async function saveSubscription(db: Db, orgId: string, patch: SubscriptionPatch): Promise<SubscriptionRecord> {
  const existing = await subscriptionForOrg(db, orgId);
  const now = new Date();

  if (!existing) {
    const [row] = await db
      .insert(subscriptions)
      .values({ id: ulid(), orgId, ...patch, updatedAt: now })
      .returning();
    return asRecord(row!);
  }

  const [row] = await db
    .update(subscriptions)
    .set({ ...patch, updatedAt: now })
    .where(eq(subscriptions.orgId, orgId))
    .returning();
  return asRecord(row!);
}

/**
 * Has this exact Stripe event already been applied?
 *
 * Stripe retries — on a timeout, on a non-2xx, on its own schedule — and a
 * retry that re-runs a handler is how a cancelled subscription comes back to
 * life. The insert is the claim: it succeeds once and conflicts forever after,
 * so two deliveries racing each other cannot both win.
 *
 * Claimed BEFORE the work, not after. The alternative loses an event whenever
 * the process dies mid-handler; this one at worst drops an event we crashed
 * on, which Stripe's dashboard shows as delivered and a person can replay
 * deliberately. Handlers are written to be safe to replay anyway — this is the
 * belt, not the only trousers.
 */
export async function claimEvent(db: Db, eventId: string, type: string): Promise<boolean> {
  const claimed = await db
    .insert(stripeEvents)
    .values({ eventId, type })
    .onConflictDoNothing()
    .returning({ eventId: stripeEvents.eventId });
  return claimed.length > 0;
}
