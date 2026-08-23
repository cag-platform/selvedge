import Stripe from 'stripe';
import type { BillingInterval } from '../../shared/plans.js';

/**
 * THE STRIPE SEAM — everything that talks to Stripe, and nothing that decides
 * anything.
 *
 * Two rules this file exists to hold.
 *
 * 1. SELVEDGE NEVER TOUCHES CARD DATA. There is no card form anywhere in this
 *    product and there must never be one. Buying goes through Stripe Checkout;
 *    changing a card, switching monthly to yearly, and cancelling all go
 *    through the Stripe Customer Portal. What that buys is not convenience —
 *    it is that a card number cannot leak from a system it never enters.
 *
 * 2. A GATEWAY, NOT A CLIENT. The four calls the product makes are named here
 *    behind a type, so the routes and the webhook handler can be tested
 *    exhaustively against a stand-in — including the failure paths, which are
 *    the ones that matter and the ones a live-Stripe-only test would never
 *    reach. It also keeps the SDK's types out of the handlers, so a version
 *    bump is a change to this file rather than a change everywhere.
 *
 * The event shape below is deliberately OUR shape, not Stripe's. Stripe has
 * moved fields between API versions (`current_period_end` living on the
 * subscription and later on its items, for one), so the reading happens once,
 * here, tolerantly, and returns nothing rather than a guess when it recognises
 * nothing.
 */

export type StripeConfig = {
  secretKey: string | undefined;
  webhookSecret: string | undefined;
  priceMonthly: string | undefined;
  priceYearly: string | undefined;
  /**
   * Once this flips, new subscriptions stop being grandfathered at the
   * founding-member price. It is a promise with a switch rather than a date,
   * because the promise is "you keep what you signed up at" and only this can
   * say when signing up stopped meaning that.
   */
  pricingV2: boolean;
};

export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY?.trim() || undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
    priceMonthly: env.STRIPE_PRICE_PRO_MONTHLY?.trim() || undefined,
    priceYearly: env.STRIPE_PRICE_PRO_YEARLY?.trim() || undefined,
    pricingV2: env.PRICING_V2_ENABLED === 'true',
  };
}

/** What a subscription looked like at the moment an event was sent. */
export type SubscriptionFacts = {
  customerId: string | null;
  subscriptionId: string | null;
  /** Stripe's own status string, unmapped — the entitlements module decides what it means. */
  status: string | null;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  /** Written by us at checkout, so an event can find its way home. */
  orgId: string | null;
  userId: string | null;
};

export type BillingEvent = {
  id: string;
  type: string;
  facts: SubscriptionFacts;
};

export type CheckoutRequest = {
  orgId: string;
  /** Attribution: who put the card in. Never tenancy — see db/schema/billing.ts. */
  userId: string | null;
  customerId: string | null;
  priceId: string;
  interval: BillingInterval;
  successUrl: string;
  cancelUrl: string;
};

export type StripeGateway = {
  /** A customer created up front so every later webhook has something to resolve against. */
  createCustomer(input: { orgId: string; userId: string | null }): Promise<string>;
  createCheckoutSession(input: CheckoutRequest): Promise<{ id: string; url: string | null }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Throws when the signature does not verify. The caller turns that into a 400 and nothing else. */
  constructEvent(rawBody: Buffer, signature: string): BillingEvent;
};

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Stripe sends unix seconds. Zero and null both mean "not set", never 1970. */
function seconds(v: unknown): Date | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;
}

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

/**
 * Read what we need out of whichever object this event carried — a checkout
 * session, a subscription, or an invoice — without caring which.
 *
 * Written tolerantly on purpose. Every field is looked for in the places Stripe
 * has put it, and anything not found comes back null rather than as a default,
 * because a wrong period end silently changes when somebody loses access.
 */
export function readFacts(event: Json): SubscriptionFacts {
  const object = obj(obj(event.data)?.object) ?? {};
  const metadata = obj(object.metadata) ?? {};
  // A subscription's metadata is the copy that survives: a checkout session is
  // a one-off, but `customer.subscription.updated` fires for years.
  const subMetadata = obj(obj(object.subscription)?.metadata) ?? {};

  const subscriptionId =
    str(object.subscription) ?? // checkout session / invoice: an id string
    str(obj(object.subscription)?.id) ??
    (str(object.object) === 'subscription' ? str(object.id) : null) ??
    str(obj(object.parent)?.subscription_details as unknown) ??
    null;

  const items = obj(object.items)?.data;
  const firstItem = Array.isArray(items) ? (obj(items[0]) ?? {}) : {};
  const lines = obj(object.lines)?.data;
  const firstLine = Array.isArray(lines) ? (obj(lines[0]) ?? {}) : {};

  return {
    customerId: str(object.customer) ?? str(obj(object.customer)?.id),
    subscriptionId,
    status: str(object.status),
    priceId:
      str(obj(firstItem.price)?.id) ??
      str(obj(firstLine.price)?.id) ??
      str(obj(obj(firstLine.pricing)?.price_details)?.price) ??
      null,
    // Top level is where it lived; per-item is where it moved; an invoice's
    // line period is the fallback that is right for `invoice.paid`.
    currentPeriodEnd:
      seconds(object.current_period_end) ??
      seconds(firstItem.current_period_end) ??
      seconds(obj(firstLine.period)?.end) ??
      seconds(object.period_end),
    orgId: str(metadata.org_id) ?? str(subMetadata.org_id) ?? str(object.client_reference_id),
    userId: str(metadata.user_id) ?? str(subMetadata.user_id),
  };
}

/** The real thing. Constructed only where a secret key exists. */
export function stripeGateway(secretKey: string, webhookSecret: string | undefined): StripeGateway {
  const stripe = new Stripe(secretKey);

  return {
    async createCustomer({ orgId, userId }) {
      const customer = await stripe.customers.create({
        metadata: { org_id: orgId, ...(userId ? { user_id: userId } : {}) },
      });
      return customer.id;
    },

    async createCheckoutSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: input.customerId ?? undefined,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        // The brief's field, kept: who bought it, as Stripe's own idea of a
        // reference. The org travels in metadata because it is the tenant and
        // has to survive onto the subscription itself.
        ...(input.userId ? { client_reference_id: input.userId } : {}),
        metadata: { org_id: input.orgId, ...(input.userId ? { user_id: input.userId } : {}) },
        subscription_data: {
          metadata: { org_id: input.orgId, ...(input.userId ? { user_id: input.userId } : {}) },
        },
      });
      return { id: session.id, url: session.url };
    },

    async createPortalSession({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
      return { url: session.url };
    },

    constructEvent(rawBody, signature) {
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      // Stripe's own verification: HMAC-SHA256 over the raw bytes, compared in
      // constant time, with a timestamp tolerance that makes a captured request
      // unusable later. It throws on any of those failing, which is the only
      // behaviour the caller wants.
      const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as unknown as Json;
      return { id: String(event.id), type: String(event.type), facts: readFacts(event) };
    },
  };
}

export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): StripeGateway | null {
  const cfg = stripeConfig(env);
  return cfg.secretKey ? stripeGateway(cfg.secretKey, cfg.webhookSecret) : null;
}
