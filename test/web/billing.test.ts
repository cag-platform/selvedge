import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import Stripe from 'stripe';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, packs, subscriptions } from '../../src/server/db/schema/index.js';
import { createBillingRouter } from '../../src/server/web/routes/billing.js';
import { createStripeWebhookRouter } from '../../src/server/web/routes/stripeWebhook.js';
import { saveSubscription, subscriptionForOrg } from '../../src/server/billing/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createPack } from '../../src/server/packs/store.js';
import { stripeGateway, type CheckoutRequest, type StripeConfig, type StripeGateway } from '../../src/server/billing/stripe.js';
import { appWithOrg } from './helpers.js';
import { priceLine } from '../../src/shared/plans.js';

const CONFIG: StripeConfig = {
  secretKey: 'sk_test_x',
  webhookSecret: 'whsec_test_x',
  priceMonthly: 'price_monthly',
  priceYearly: 'price_yearly',
  pricingV2: false,
};

describe('web/routes/billing — buying, managing, and seeing what you are on', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  /** Stands in for Stripe. Records what it was asked for, so the route's contract is visible. */
  function fakeGateway() {
    const calls: { customers: number; checkout: CheckoutRequest[]; portal: Array<{ customerId: string }> } = {
      customers: 0,
      checkout: [],
      portal: [],
    };
    const gateway: StripeGateway = {
      async createCustomer() {
        calls.customers += 1;
        return `cus_made_${calls.customers}`;
      },
      async createCheckoutSession(input) {
        calls.checkout.push(input);
        return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' };
      },
      async createPortalSession(input) {
        calls.portal.push({ customerId: input.customerId });
        return { url: 'https://billing.stripe.com/p/session/1' };
      },
      constructEvent() {
        throw new Error('not used here');
      },
    };
    return { gateway, calls };
  }

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  const app = (gateway: StripeGateway | null) =>
    appWithOrg(orgId, createBillingRouter(db, { gateway, config: CONFIG, appUrl: 'https://selvedge.test' }));

  describe('what this account is on', () => {
    it('answers free for an account nobody has ever billed, with the numbers the screen needs', async () => {
      await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      const res = await request(app(fakeGateway().gateway)).get('/api/billing');

      expect(res.status).toBe(200);
      expect(res.body.plan).toBe('free');
      expect(res.body.plan_name).toBe('Free');
      expect(res.body.needs_attention).toBe(false);
      expect(res.body.projects).toEqual({ used: 1, limit: 2 });
      expect(res.body.build_minutes).toEqual({ used: 0, limit: 60, remaining: 60 });
      expect(res.body.history_days).toBe(30);
    });

    /**
     * THE ONE THAT MATTERS. The row still says plan 'pro' after a subscription
     * lapses — that is how the grace period is expressed. The screen must show
     * what the GATES do, not what the row says, or it will tell somebody they
     * are on Pro for a week after they stopped being.
     */
    it('shows the plan as enforced, not as sold', async () => {
      await saveSubscription(db, orgId, {
        plan: 'pro',
        status: 'canceled',
        currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const res = await request(app(fakeGateway().gateway)).get('/api/billing');
      expect(res.body.plan).toBe('free');
    });

    it('flags a failed payment as something to act on', async () => {
      await saveSubscription(db, orgId, { plan: 'pro', status: 'past_due', currentPeriodEnd: new Date() });
      const res = await request(app(fakeGateway().gateway)).get('/api/billing');
      expect(res.body.needs_attention).toBe(true);
      // Still Pro while the grace period runs — a failed card is not a lockout.
      expect(res.body.plan).toBe('pro');
    });

    /** The prices come from the shared table, so this screen cannot drift from the pricing page. */
    it('quotes the same prices the pricing page renders', async () => {
      const res = await request(app(fakeGateway().gateway)).get('/api/billing');
      const pro = res.body.plans.find((p: { id: string }) => p.id === 'pro');
      expect(pro.monthly).toBe(priceLine('pro'));
      expect(pro.yearly).toBe(priceLine('pro', 'yearly'));
      expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'pro']);
    });

    it('says plainly when this deployment cannot take money at all', async () => {
      const res = await request(app(null)).get('/api/billing');
      expect(res.body.can_checkout).toBe(false);
    });

    it('is org-scoped', async () => {
      await saveSubscription(db, orgId, { plan: 'pro', status: 'active', currentPeriodEnd: new Date(Date.now() + 86_400_000) });
      const theirs = appWithOrg('org_2', createBillingRouter(db, { gateway: fakeGateway().gateway, config: CONFIG }));
      expect((await request(theirs).get('/api/billing')).body.plan).toBe('free');
    });
  });

  describe('starting a purchase', () => {
    /**
     * The customer is created and stored BEFORE the browser is sent anywhere,
     * because the webhook regularly beats it back — and a handler with no
     * customer id has nothing to find the org by.
     */
    it('writes the Stripe customer before it hands back a checkout link', async () => {
      const { gateway, calls } = fakeGateway();
      const res = await request(app(gateway)).post('/api/billing/checkout').send({ interval: 'monthly' });

      expect(res.status).toBe(201);
      expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect((await subscriptionForOrg(db, orgId))!.stripeCustomerId).toBe('cus_made_1');
      expect(calls.checkout[0]).toMatchObject({ orgId, customerId: 'cus_made_1', priceId: 'price_monthly', interval: 'monthly' });
      expect(calls.checkout[0]!.successUrl).toBe('https://selvedge.test/admin/billing?bought=1');
    });

    /** Two customers for one org is how an account ends up with two subscriptions. */
    it('reuses the customer it already made', async () => {
      const { gateway, calls } = fakeGateway();
      await request(app(gateway)).post('/api/billing/checkout').send({ interval: 'monthly' });
      await request(app(gateway)).post('/api/billing/checkout').send({ interval: 'yearly' });

      expect(calls.customers).toBe(1);
      expect(calls.checkout.map((c) => c.priceId)).toEqual(['price_monthly', 'price_yearly']);
      expect(await db.select().from(subscriptions)).toHaveLength(1);
    });

    it('defaults to monthly and refuses an interval it does not sell', async () => {
      const { gateway, calls } = fakeGateway();
      expect((await request(app(gateway)).post('/api/billing/checkout').send({})).status).toBe(201);
      expect(calls.checkout[0]!.interval).toBe('monthly');

      const bad = await request(app(gateway)).post('/api/billing/checkout').send({ interval: 'weekly' });
      expect(bad.status).toBe(400);
    });

    it('is a clear 503 when this deployment has no Stripe keys', async () => {
      const res = await request(app(null)).post('/api/billing/checkout').send({ interval: 'monthly' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not switched on/i);
    });

    it('is a clear 503 when the price for that interval is not configured', async () => {
      const noYearly = appWithOrg(
        orgId,
        createBillingRouter(db, { gateway: fakeGateway().gateway, config: { ...CONFIG, priceYearly: undefined } }),
      );
      const res = await request(noYearly).post('/api/billing/checkout').send({ interval: 'yearly' });
      expect(res.status).toBe(503);
    });

    /** Nothing was charged, and the sentence says so — money is never left ambiguous. */
    it('says nothing was charged when Stripe returns no page', async () => {
      const { gateway } = fakeGateway();
      gateway.createCheckoutSession = async () => ({ id: 'cs_1', url: null });
      const res = await request(app(gateway)).post('/api/billing/checkout').send({});
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/[Nn]othing was charged/);
    });
  });

  describe('managing an existing subscription', () => {
    it('hands back a portal link for the customer on this org', async () => {
      const { gateway, calls } = fakeGateway();
      await saveSubscription(db, orgId, { stripeCustomerId: 'cus_existing' });

      const res = await request(app(gateway)).post('/api/billing/portal').send({});
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
      expect(calls.portal).toEqual([{ customerId: 'cus_existing' }]);
    });

    it('says there is nothing to manage rather than passing a Stripe error through', async () => {
      const res = await request(app(fakeGateway().gateway)).post('/api/billing/portal').send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no subscription on this account/i);
    });
  });

  /**
   * THE WEBHOOK DOOR — the one route in this product that is not behind a
   * session. What makes that safe is the signature, so these tests use the real
   * Stripe SDK to sign (and mis-sign) real payloads rather than a stand-in.
   * A stubbed verifier would pass whether or not verification actually worked.
   */
  describe('the webhook door', () => {
    const secret = 'whsec_' + 'a'.repeat(32);
    const stripe = new Stripe('sk_test_x');

    /** The app as it is really assembled: raw body on this path, JSON everywhere else. */
    function webhookApp() {
      const app = express();
      // The REAL gateway, so verification is Stripe's own code rather than a
      // stand-in that would pass whether or not it worked.
      const gateway = stripeGateway('sk_test_x', secret);
      app.use(createStripeWebhookRouter(db, { gateway, config: { ...CONFIG, webhookSecret: secret } }));
      app.use(express.json());
      return app;
    }

    const payload = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        id: 'evt_signed_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            object: 'checkout.session',
            customer: 'cus_signed',
            subscription: 'sub_signed',
            metadata: { org_id: orgId, user_id: 'user_1' },
          },
        },
        ...over,
      });

    const sign = (body: string) => stripe.webhooks.generateTestHeaderString({ payload: body, secret });

    it('accepts a properly signed event and applies it', async () => {
      const body = payload();
      const res = await request(webhookApp())
        .post('/api/stripe/webhook')
        .set('stripe-signature', sign(body))
        .set('content-type', 'application/json')
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ received: true, handled: 'checkout.session.completed' });
      expect((await subscriptionForOrg(db, orgId))!.plan).toBe('pro');
    });

    it('refuses a body whose signature does not match it', async () => {
      const signedBody = payload();
      // The classic forgery: a valid signature lifted from one payload, put on
      // another that says the attacker is on Pro.
      const tampered = payload({ id: 'evt_forged' });
      const res = await request(webhookApp())
        .post('/api/stripe/webhook')
        .set('stripe-signature', sign(signedBody))
        .set('content-type', 'application/json')
        .send(tampered);

      expect(res.status).toBe(400);
      expect(await subscriptionForOrg(db, orgId)).toBeNull();
    });

    it('refuses an unsigned request outright', async () => {
      const res = await request(webhookApp()).post('/api/stripe/webhook').set('content-type', 'application/json').send(payload());
      expect(res.status).toBe(400);
      expect(await subscriptionForOrg(db, orgId)).toBeNull();
    });

    it('refuses a signature made with the wrong secret', async () => {
      const body = payload();
      const wrong = stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_' + 'b'.repeat(32) });
      const res = await request(webhookApp())
        .post('/api/stripe/webhook')
        .set('stripe-signature', wrong)
        .set('content-type', 'application/json')
        .send(body);
      expect(res.status).toBe(400);
    });

    /** Stripe's own tolerance: a captured delivery cannot be replayed later. */
    it('refuses a signature that is too old to be live traffic', async () => {
      const body = payload();
      const stale = stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret,
        timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
      });
      const res = await request(webhookApp())
        .post('/api/stripe/webhook')
        .set('stripe-signature', stale)
        .set('content-type', 'application/json')
        .send(body);
      expect(res.status).toBe(400);
    });

    /**
     * A retry is Stripe working as designed and an unknown type is Stripe being
     * chatty. Answering either with an error would make the dashboard show a
     * failing endpoint, and an endpoint that is always failing is one nobody
     * looks at when it really is.
     */
    it('answers 200 to a retry and to a type it does not handle', async () => {
      const body = payload();
      const app = webhookApp();
      await request(app).post('/api/stripe/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body);

      const again = await request(app).post('/api/stripe/webhook').set('stripe-signature', sign(body)).set('content-type', 'application/json').send(body);
      expect(again.status).toBe(200);
      expect(again.body.skipped).toBe('duplicate');

      const chatty = payload({ id: 'evt_other', type: 'customer.created' });
      const other = await request(app)
        .post('/api/stripe/webhook')
        .set('stripe-signature', sign(chatty))
        .set('content-type', 'application/json')
        .send(chatty);
      expect(other.status).toBe(200);
      expect(other.body.skipped).toBe('unknown_event');
    });

    it('asks Stripe to retry rather than giving up when the keys are not set', async () => {
      const unconfigured = express();
      unconfigured.use(createStripeWebhookRouter(db, { gateway: null, config: { ...CONFIG, webhookSecret: undefined } }));
      const res = await request(unconfigured)
        .post('/api/stripe/webhook')
        .set('stripe-signature', 't=1,v1=x')
        .set('content-type', 'application/json')
        .send('{}');
      expect(res.status).toBe(503);
    });

    /** Nothing is deleted by any of this, ever. */
    it('leaves every project where it was when a subscription is cancelled', async () => {
      await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
      await saveSubscription(db, orgId, { stripeCustomerId: 'cus_signed', plan: 'pro', status: 'active' });

      const body = payload({ id: 'evt_cancel', type: 'customer.subscription.deleted' });
      await request(webhookApp())
        .post('/api/stripe/webhook')
        .set('stripe-signature', sign(body))
        .set('content-type', 'application/json')
        .send(body);

      expect((await subscriptionForOrg(db, orgId))!.status).toBe('canceled');
      expect(await db.select().from(packs)).toHaveLength(1);
    });
  });
});
