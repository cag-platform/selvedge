import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { gatewayFromEnv, stripeConfig, type StripeConfig, type StripeGateway } from '../../billing/stripe.js';
import { saveSubscription, subscriptionForOrg } from '../../billing/store.js';
import { entitlementsFor } from '../../billing/entitlements.js';
import { PLANS, planLimits, priceLine, type BillingInterval } from '../../../shared/plans.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

function userIdOf(req: Request): string | null {
  return (req as Request & { userId?: string | null }).userId ?? null;
}

/**
 * BUYING, MANAGING, AND SEEING WHAT YOU ARE ON.
 *
 * Three routes, and between them exactly one page of UI. Everything that
 * touches a card — entering one, changing one, cancelling, switching monthly to
 * yearly — happens on Stripe's own pages, reached through a link this route
 * mints. Selvedge never touches card data, and the way that promise is kept is
 * that there is nowhere in this codebase for a card number to go.
 *
 * The status route answers from `entitlements.ts` rather than from the
 * subscription row, so what the billing screen shows is what the gates actually
 * do. A billing page that reads the row directly is a billing page that says
 * "Pro" for a week after the grace period ran out.
 */
export type BillingRouterDeps = {
  gateway?: StripeGateway | null;
  config?: StripeConfig;
  /** Where Stripe sends the browser back to. Absent in tests, defaulted from the request. */
  appUrl?: string;
};

export function createBillingRouter(db: Db, deps: BillingRouterDeps = {}) {
  const router = Router();
  const gateway = deps.gateway === undefined ? gatewayFromEnv() : deps.gateway;
  const config = deps.config ?? stripeConfig();

  const baseUrl = (req: Request) => deps.appUrl ?? process.env.APP_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;

  /**
   * What this account is on, what it has used, and what the alternatives cost —
   * in one request, because the billing screen is one glance.
   */
  router.get(
    '/api/billing',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const [row, entitlements] = await Promise.all([subscriptionForOrg(db, orgId), entitlementsFor(db, orgId)]);

      res.json({
        // The plan as ENFORCED, which is not always the plan as sold: a lapsed
        // subscription still says plan 'pro' in the row while resolving to free
        // here, and the screen must show the second one.
        plan: entitlements.plan,
        plan_name: planLimits(entitlements.plan).name,
        status: row?.status ?? 'active',
        billing_interval: row?.billingInterval ?? null,
        current_period_end: row?.currentPeriodEnd ?? null,
        grandfathered_price: row?.grandfatheredPrice ?? false,
        // True when the money has a problem the owner has to fix. The banner
        // hangs off this rather than off the status string, so there is one
        // answer to "is something wrong" instead of a client-side match.
        needs_attention: row?.status === 'past_due',
        build_minutes: entitlements.buildMinutes,
        projects: { used: entitlements.projects.used, limit: entitlements.projects.limit },
        history_days: planLimits(entitlements.plan).historyDays,
        // Rendered from the shared plan table, so this screen and the pricing
        // page can never disagree about what Pro costs.
        plans: PLANS.filter((p) => p.shipped).map((p) => ({
          id: p.id,
          name: p.name,
          monthly: priceLine(p.id),
          yearly: p.priceUsd.yearly === null ? null : priceLine(p.id, 'yearly'),
        })),
        can_checkout: Boolean(gateway && config.priceMonthly && config.priceYearly),
      });
    }),
  );

  /**
   * Start buying. Creates the Stripe customer FIRST and stores it, before the
   * browser is sent anywhere.
   *
   * That order is the fix for a real race: the `checkout.session.completed`
   * webhook regularly beats the owner's browser back from Stripe, and a handler
   * that had to find the org from session state would have nothing to look in.
   * With the customer written up front, every future event for this account —
   * for years — resolves by customer id alone.
   */
  router.post(
    '/api/billing/checkout',
    asyncHandler(async (req, res) => {
      if (!gateway) {
        res.status(503).json({ error: 'Billing is not switched on for this deployment.' });
        return;
      }
      const interval = ((req.body as { interval?: unknown })?.interval ?? 'monthly') as BillingInterval;
      if (interval !== 'monthly' && interval !== 'yearly') {
        res.status(400).json({ error: "interval must be 'monthly' or 'yearly'" });
        return;
      }
      const priceId = interval === 'yearly' ? config.priceYearly : config.priceMonthly;
      if (!priceId) {
        res.status(503).json({ error: `No ${interval} price is configured for this deployment.` });
        return;
      }

      const orgId = orgIdOf(req);
      const userId = userIdOf(req);
      const existing = await subscriptionForOrg(db, orgId);

      // Reuse the customer we already made for this org. A second customer for
      // the same account is how one org ends up with two subscriptions and a
      // webhook that updates the wrong one.
      let customerId = existing?.stripeCustomerId ?? null;
      if (!customerId) {
        customerId = await gateway.createCustomer({ orgId, userId });
        await saveSubscription(db, orgId, { stripeCustomerId: customerId, ...(userId ? { boughtByUserId: userId } : {}) });
      }

      const base = baseUrl(req);
      const session = await gateway.createCheckoutSession({
        orgId,
        userId,
        customerId,
        priceId,
        interval,
        successUrl: `${base}/admin/billing?bought=1`,
        cancelUrl: `${base}/admin/billing`,
      });

      if (!session.url) {
        res.status(502).json({ error: 'Stripe did not return a checkout page. Nothing was charged.' });
        return;
      }
      res.status(201).json({ url: session.url });
    }),
  );

  /**
   * The Customer Portal: change the card, switch monthly to yearly, cancel.
   * All of it Stripe's own screens, none of it ours.
   */
  router.post(
    '/api/billing/portal',
    asyncHandler(async (req, res) => {
      if (!gateway) {
        res.status(503).json({ error: 'Billing is not switched on for this deployment.' });
        return;
      }
      const existing = await subscriptionForOrg(db, orgIdOf(req));
      if (!existing?.stripeCustomerId) {
        // Nothing has ever been bought here, so there is nothing to manage —
        // said as itself rather than as a Stripe error about a missing customer.
        res.status(409).json({ error: "There's no subscription on this account yet." });
        return;
      }
      const session = await gateway.createPortalSession({
        customerId: existing.stripeCustomerId,
        returnUrl: `${baseUrl(req)}/admin/billing`,
      });
      res.json({ url: session.url });
    }),
  );

  return router;
}
