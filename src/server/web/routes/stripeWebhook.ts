import express, { Router } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { handleBillingEvent } from '../../billing/webhook.js';
import { gatewayFromEnv, stripeConfig, type StripeConfig, type StripeGateway } from '../../billing/stripe.js';

/**
 * THE ONE DOOR INTO THIS PRODUCT THAT IS NOT BEHIND A SESSION.
 *
 * Anyone on the internet can POST here. What makes that safe is one thing and
 * only one thing: the signature. Stripe signs every delivery with a shared
 * secret over the EXACT BYTES it sent, so this route must see those bytes —
 * hence `express.raw` mounted on the path itself, ahead of the app's JSON
 * parser. A body that has been parsed and re-serialised will not verify, and
 * the failure mode is a webhook endpoint that rejects everything, which reads
 * as "Stripe is broken" for as long as it takes somebody to find this comment.
 *
 * Verification is Stripe's own: HMAC-SHA256, compared in constant time, with a
 * timestamp tolerance so a captured request cannot be replayed later. It throws
 * on failure and the answer is 400 with nothing else — no detail about which
 * part failed, because that detail is only useful to somebody forging one.
 *
 * NEVER TRUST THE BODY OVER THE SIGNATURE. There is no path here that reads the
 * payload before it verifies, and no "development mode" that skips the check.
 * A forged `customer.subscription.updated` is a free Pro account.
 */
export type StripeWebhookDeps = {
  gateway?: StripeGateway | null;
  config?: StripeConfig;
};

export function createStripeWebhookRouter(db: Db, deps: StripeWebhookDeps = {}) {
  const router = Router();
  const gateway = deps.gateway === undefined ? gatewayFromEnv() : deps.gateway;
  const config = deps.config ?? stripeConfig();

  router.post(
    '/api/stripe/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    asyncHandler(async (req, res) => {
      // Not configured is 503, not 400: nothing is wrong with the request, and
      // Stripe should retry once somebody sets the keys rather than give up.
      if (!gateway || !config.webhookSecret) {
        res.status(503).json({ error: 'billing is not configured on this deployment' });
        return;
      }

      const signature = req.header('stripe-signature');
      const body = req.body;
      if (!signature || !Buffer.isBuffer(body)) {
        res.status(400).json({ error: 'bad signature' });
        return;
      }

      let event;
      try {
        event = gateway.constructEvent(body, signature);
      } catch {
        res.status(400).json({ error: 'bad signature' });
        return;
      }

      const outcome = await handleBillingEvent(db, event, config);

      // 200 for everything that verified, including the ones we did nothing
      // with. A duplicate is the retry working as designed; an unknown type is
      // Stripe being chatty. Answering either with an error would make the
      // dashboard show a failing endpoint, and an endpoint that is always
      // failing is one nobody looks at when it really is.
      if (!outcome.handled && outcome.reason === 'unattributable') {
        // Said loudly, because this is money moving for a customer we have lost
        // track of — the one case here that a person needs to see.
        console.error(`stripe webhook ${event.type} (${event.id}) could not be attributed to an org`);
      }
      res.json({ received: true, ...(outcome.handled ? { handled: outcome.event } : { skipped: outcome.reason }) });
    }),
  );

  return router;
}
