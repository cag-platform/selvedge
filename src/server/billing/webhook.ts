import type { Db } from '../db/client.js';
import type { BillingEvent, StripeConfig, SubscriptionFacts } from './stripe.js';
import { claimEvent, saveSubscription, subscriptionForCustomer, type SubscriptionPatch } from './store.js';
import type { BillingInterval, SubscriptionStatus } from '../../shared/plans.js';

/**
 * WHAT STRIPE SAYS, TURNED INTO WHAT THE OWNER MAY DO.
 *
 * Five events, and one idea running through all of them: this file records
 * FACTS ABOUT THE MONEY and never decides access. Whether a past-due
 * subscription still opens the door is `entitlements.ts`'s question, answered
 * from the status and the period end written here. Splitting it that way means
 * the grace period is one rule in one place rather than a condition repeated
 * across five handlers that will eventually disagree.
 *
 * EVERY HANDLER IS SAFE TO REPLAY. Stripe retries, deliveries arrive out of
 * order, and a person can re-send an event from the dashboard years later.
 * Nothing here appends, increments, or toggles; each handler writes the state
 * the event describes, so applying the same one twice lands in the same place
 * as applying it once. The `stripe_events` claim on top of that stops the
 * common case cheaply.
 *
 * NOTHING IS EVER DELETED. A cancellation writes a status. It does not touch a
 * project, a thread, a run, or a single message — that is the promise the whole
 * plan design rests on, and it is kept by there being no delete in this file.
 */

export type WebhookOutcome =
  | { handled: true; orgId: string; event: string }
  | { handled: false; reason: 'duplicate' | 'unknown_event' | 'unattributable' };

/**
 * Which org an event belongs to.
 *
 * The customer id first, because it is the one thing every event carries and
 * because we wrote it before the redirect — so this works even when the webhook
 * beats the owner's browser back from Checkout. The metadata we stamped onto
 * the subscription is the fallback for the one case the customer lookup cannot
 * cover: the very first event for a customer created outside our checkout flow
 * (a subscription started by hand in the Stripe dashboard, say).
 */
async function orgFor(db: Db, facts: SubscriptionFacts): Promise<string | null> {
  if (facts.customerId) {
    const existing = await subscriptionForCustomer(db, facts.customerId);
    if (existing) return existing.orgId;
  }
  return facts.orgId;
}

/** Which of the two prices this is, or null when it is neither. */
function intervalFor(priceId: string | null, cfg: StripeConfig): BillingInterval | null {
  if (!priceId) return null;
  if (cfg.priceMonthly && priceId === cfg.priceMonthly) return 'monthly';
  if (cfg.priceYearly && priceId === cfg.priceYearly) return 'yearly';
  return null;
}

/**
 * Stripe's status vocabulary is larger than ours and grows. Map only what we
 * have decided about; anything else is treated as not-currently-paying, which
 * is the safe direction for a word we have never seen.
 *
 * `incomplete` and `incomplete_expired` are a checkout that never completed, so
 * they are not past_due — nobody has been charged and there is nothing to give
 * grace on. `unpaid` is what past_due becomes when Stripe gives up retrying,
 * and by then our own grace has long since run out.
 */
function statusFor(stripeStatus: string | null): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    default:
      return 'canceled';
  }
}

/**
 * Anyone who subscribes before pricing_v2 keeps their price through any later
 * raise. Read once, at the moment of buying — never recomputed, because the
 * whole point is that flipping the flag must not reach backwards.
 */
function grandfathered(cfg: StripeConfig): boolean {
  return !cfg.pricingV2;
}

export async function handleBillingEvent(db: Db, event: BillingEvent, cfg: StripeConfig): Promise<WebhookOutcome> {
  const known = new Set([
    'checkout.session.completed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
    'invoice.paid',
  ]);
  // An event we do not handle is not an error. Stripe sends dozens of types and
  // a 400 on any of them would make its dashboard show a failing endpoint,
  // which is how a real failure later gets ignored.
  if (!known.has(event.type)) return { handled: false, reason: 'unknown_event' };

  const orgId = await orgFor(db, event.facts);
  // Nothing to attribute this to. Reported rather than swallowed: an event we
  // cannot place is money moving for a customer we have lost track of.
  if (!orgId) return { handled: false, reason: 'unattributable' };

  if (!(await claimEvent(db, event.id, event.type))) return { handled: false, reason: 'duplicate' };

  const { facts } = event;
  const ids: SubscriptionPatch = {
    ...(facts.customerId ? { stripeCustomerId: facts.customerId } : {}),
    ...(facts.subscriptionId ? { stripeSubscriptionId: facts.subscriptionId } : {}),
    ...(facts.currentPeriodEnd ? { currentPeriodEnd: facts.currentPeriodEnd } : {}),
  };

  switch (event.type) {
    /**
     * Bought. The one event that may set the plan and the grandfathered price,
     * because it is the only one that means "this person just decided to pay".
     */
    case 'checkout.session.completed': {
      const interval = intervalFor(facts.priceId, cfg);
      await saveSubscription(db, orgId, {
        ...ids,
        plan: 'pro',
        status: 'active',
        grandfatheredPrice: grandfathered(cfg),
        ...(interval ? { billingInterval: interval } : {}),
        ...(facts.userId ? { boughtByUserId: facts.userId } : {}),
      });
      break;
    }

    /**
     * Changed: renewed, upgraded monthly to yearly in the Portal, or moved to
     * past_due. The plan is not touched — an update never means "they bought
     * something new", and reading `pro` out of a status field would be reading
     * a fact that isn't there.
     */
    case 'customer.subscription.updated': {
      const interval = intervalFor(facts.priceId, cfg);
      await saveSubscription(db, orgId, {
        ...ids,
        status: statusFor(facts.status),
        ...(interval ? { billingInterval: interval } : {}),
      });
      break;
    }

    /**
     * Cancelled. The plan STAYS 'pro' and the status becomes 'canceled' — they
     * paid through the end of the period and they keep it until then, which is
     * `entitlements.ts`'s reading of exactly these two fields. Writing 'free'
     * here would take away time already paid for.
     */
    case 'customer.subscription.deleted': {
      await saveSubscription(db, orgId, { ...ids, status: 'canceled' });
      break;
    }

    /**
     * A charge failed. Not a cancellation: the grace period starts from the
     * period end already recorded, and the owner keeps everything meanwhile
     * with a banner saying what happened.
     *
     * The period end is deliberately NOT written from a failed invoice — the
     * grace clock hangs off what was last successfully paid for, and moving it
     * forward on a failure would extend access every time a retry failed.
     */
    case 'invoice.payment_failed': {
      const { currentPeriodEnd: _ignored, ...withoutPeriod } = ids;
      await saveSubscription(db, orgId, { ...withoutPeriod, status: 'past_due' });
      break;
    }

    /** Renewed. Back to active, and the period end moves to what was just paid for. */
    case 'invoice.paid': {
      await saveSubscription(db, orgId, { ...ids, status: 'active' });
      break;
    }
  }

  return { handled: true, orgId, event: event.type };
}
