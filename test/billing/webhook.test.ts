import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { handleBillingEvent } from '../../src/server/billing/webhook.js';
import { readFacts, type BillingEvent, type StripeConfig } from '../../src/server/billing/stripe.js';
import { saveSubscription, subscriptionForOrg } from '../../src/server/billing/store.js';
import { getPlan } from '../../src/server/billing/entitlements.js';
import { PAST_DUE_GRACE_DAYS } from '../../src/shared/plans.js';

/**
 * WHAT STRIPE SAYS, TURNED INTO WHAT THE OWNER MAY DO.
 *
 * Two properties are worth more than the rest here. Every handler must be safe
 * to replay, because Stripe retries and a person can re-send an event from the
 * dashboard years later — and nothing may ever be deleted, because a
 * cancellation that took data with it would make paying again not get it back.
 */
describe('the billing webhook', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const customerId = 'cus_123';
  const day = 24 * 60 * 60 * 1000;

  const cfg: StripeConfig = {
    secretKey: 'sk_test',
    webhookSecret: 'whsec_test',
    priceMonthly: 'price_monthly',
    priceYearly: 'price_yearly',
    pricingV2: false,
  };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  let n = 0;
  const event = (type: string, facts: Partial<BillingEvent['facts']> = {}, id?: string): BillingEvent => ({
    id: id ?? `evt_${(n += 1)}`,
    type,
    facts: {
      customerId,
      subscriptionId: 'sub_123',
      status: null,
      priceId: null,
      currentPeriodEnd: null,
      orgId: null,
      userId: null,
      ...facts,
    },
  });

  const bought = (over: Partial<BillingEvent['facts']> = {}) =>
    handleBillingEvent(
      db,
      event('checkout.session.completed', { orgId, userId: 'user_9', priceId: 'price_monthly', currentPeriodEnd: new Date(Date.now() + 30 * day), ...over }),
      cfg,
    );

  it('records a purchase: the plan, the price it was bought at, and who bought it', async () => {
    const outcome = await bought();
    expect(outcome).toMatchObject({ handled: true, orgId });

    const row = (await subscriptionForOrg(db, orgId))!;
    expect(row.plan).toBe('pro');
    expect(row.status).toBe('active');
    expect(row.billingInterval).toBe('monthly');
    expect(row.stripeCustomerId).toBe(customerId);
    expect(row.stripeSubscriptionId).toBe('sub_123');
    // Attribution, not tenancy — the row is still keyed on the org.
    expect(row.boughtByUserId).toBe('user_9');
    expect(row.orgId).toBe(orgId);
  });

  it('reads the yearly price as yearly, and an unrecognised price as neither', async () => {
    await bought({ priceId: 'price_yearly' });
    expect((await subscriptionForOrg(db, orgId))!.billingInterval).toBe('yearly');

    await close();
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await bought({ priceId: 'price_someone_made_in_the_dashboard' });
    // Not guessed at. An interval we cannot name is null, and the screen says
    // nothing rather than saying the wrong thing.
    expect((await subscriptionForOrg(db, orgId))!.billingInterval).toBeNull();
  });

  /**
   * The founding-member promise is read at the moment of buying and never
   * recomputed — flipping the flag must not reach backwards and take a price
   * off somebody who already has it.
   */
  it('grandfathers a price while pricing_v2 is off, and stops when it is on', async () => {
    await bought();
    expect((await subscriptionForOrg(db, orgId))!.grandfatheredPrice).toBe(true);

    await handleBillingEvent(db, event('checkout.session.completed', { orgId, priceId: 'price_monthly' }), { ...cfg, pricingV2: true });
    // Same org buying again under the new regime: the flag is written from the
    // config as it stands now.
    expect((await subscriptionForOrg(db, orgId))!.grandfatheredPrice).toBe(false);
  });

  /**
   * THE RACE THIS DESIGN EXISTS FOR. The webhook regularly beats the owner's
   * browser back from Stripe, so nothing may depend on session state. The
   * customer id is written before the redirect, and every later event finds its
   * way home by that alone — with no org in its metadata at all.
   */
  it('finds the org from the customer id, with nothing else to go on', async () => {
    await saveSubscription(db, orgId, { stripeCustomerId: customerId });

    const outcome = await handleBillingEvent(db, event('customer.subscription.updated', { status: 'active', orgId: null }), cfg);
    expect(outcome).toMatchObject({ handled: true, orgId });
  });

  it('says so rather than guessing when an event belongs to nobody it knows', async () => {
    const outcome = await handleBillingEvent(db, event('invoice.paid', { customerId: 'cus_stranger', orgId: null }), cfg);
    expect(outcome).toEqual({ handled: false, reason: 'unattributable' });
  });

  it('ignores the event types it does not handle, without treating them as failures', async () => {
    const outcome = await handleBillingEvent(db, event('customer.created'), cfg);
    expect(outcome).toEqual({ handled: false, reason: 'unknown_event' });
  });

  /**
   * REPLAY. Stripe retries on a timeout, on a non-2xx, and on its own schedule.
   * A retry that re-ran a handler is how a cancelled subscription comes back to
   * life.
   */
  describe('applying the same event twice', () => {
    it('claims an event id once and refuses it forever after', async () => {
      const e = event('checkout.session.completed', { orgId, priceId: 'price_monthly' }, 'evt_fixed');
      expect(await handleBillingEvent(db, e, cfg)).toMatchObject({ handled: true });
      expect(await handleBillingEvent(db, e, cfg)).toEqual({ handled: false, reason: 'duplicate' });
    });

    /**
     * And the handlers are safe to replay even without the claim: each writes
     * the state its event describes rather than changing state relative to what
     * it found. Belt and trousers, because the claim can be lost to a crash
     * between claiming and writing.
     */
    it('lands in the same place when a different delivery of the same fact arrives', async () => {
      await bought();
      const before = await subscriptionForOrg(db, orgId);

      await handleBillingEvent(db, event('checkout.session.completed', { orgId, userId: 'user_9', priceId: 'price_monthly', currentPeriodEnd: before!.currentPeriodEnd }), cfg);
      const after = await subscriptionForOrg(db, orgId);

      expect({ ...after, id: null, }).toEqual({ ...before, id: null });
    });
  });

  describe('the lifecycle after buying', () => {
    beforeEach(async () => {
      await bought();
    });

    it('moves the period end forward on a renewal', async () => {
      const renewedTo = new Date(Date.now() + 60 * day);
      await handleBillingEvent(db, event('invoice.paid', { currentPeriodEnd: renewedTo }), cfg);

      const row = (await subscriptionForOrg(db, orgId))!;
      expect(row.status).toBe('active');
      expect(row.currentPeriodEnd?.getTime()).toBe(renewedTo.getTime());
      // A renewal says nothing about which price is on the subscription, so it
      // must not blank what checkout recorded.
      expect(row.billingInterval).toBe('monthly');
    });

    /**
     * A failed charge is not a cancellation — and it must not move the grace
     * clock. The clock hangs off what was last successfully PAID FOR; moving it
     * forward on a failure would extend access every time a retry failed.
     */
    it('marks a failed payment past due without extending anything', async () => {
      const paidThrough = (await subscriptionForOrg(db, orgId))!.currentPeriodEnd!;
      await handleBillingEvent(db, event('invoice.payment_failed', { currentPeriodEnd: new Date(Date.now() + 90 * day) }), cfg);

      const row = (await subscriptionForOrg(db, orgId))!;
      expect(row.status).toBe('past_due');
      expect(row.currentPeriodEnd?.getTime()).toBe(paidThrough.getTime());
      expect(row.plan).toBe('pro');
    });

    /**
     * Cancelled keeps the PLAN and changes the STATUS, because the owner paid
     * through the end of the period and keeps it until then. Writing 'free'
     * here would take away time already bought.
     */
    it('keeps the plan on a cancellation and lets the period run out', async () => {
      await handleBillingEvent(db, event('customer.subscription.deleted', { status: 'canceled' }), cfg);

      const row = (await subscriptionForOrg(db, orgId))!;
      expect(row.plan).toBe('pro');
      expect(row.status).toBe('canceled');
      // Still Pro today, because today is inside what was paid for.
      expect(await getPlan(db, orgId)).toBe('pro');
    });

    it('treats a Stripe status it has never seen as not currently paying', async () => {
      await handleBillingEvent(db, event('customer.subscription.updated', { status: 'incomplete_expired' }), cfg);
      expect((await subscriptionForOrg(db, orgId))!.status).toBe('canceled');
    });

    it('counts a trial as active', async () => {
      await handleBillingEvent(db, event('customer.subscription.updated', { status: 'trialing' }), cfg);
      expect(await getPlan(db, orgId)).toBe('pro');
    });

    /** The whole point of writing status and period end rather than access. */
    it('hands the grace period to the entitlements module rather than deciding it here', async () => {
      const endedYesterday = new Date(Date.now() - day);
      await handleBillingEvent(db, event('customer.subscription.updated', { status: 'past_due', currentPeriodEnd: endedYesterday }), cfg);

      expect(await getPlan(db, orgId)).toBe('pro');
      expect(await getPlan(db, orgId, new Date(Date.now() + (PAST_DUE_GRACE_DAYS + 1) * day))).toBe('free');
    });
  });

  /**
   * READING STRIPE'S OBJECTS. Fields have moved between API versions, so this
   * looks in every place each one has lived and returns null rather than a
   * default when it finds none — a wrong period end silently changes when
   * somebody loses access.
   */
  describe('reading the facts off an event', () => {
    it('reads a checkout session', () => {
      const facts = readFacts({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            object: 'checkout.session',
            customer: 'cus_1',
            subscription: 'sub_1',
            client_reference_id: 'user_1',
            metadata: { org_id: 'org_7', user_id: 'user_1' },
          },
        },
      });
      expect(facts).toMatchObject({ customerId: 'cus_1', subscriptionId: 'sub_1', orgId: 'org_7', userId: 'user_1' });
    });

    it('reads a period end whether it sits on the subscription or on its items', () => {
      const at = 1_800_000_000;
      const top = readFacts({ data: { object: { object: 'subscription', id: 'sub_1', current_period_end: at } } });
      const nested = readFacts({
        data: { object: { object: 'subscription', id: 'sub_1', items: { data: [{ current_period_end: at, price: { id: 'price_monthly' } }] } } },
      });
      expect(top.currentPeriodEnd?.getTime()).toBe(at * 1000);
      expect(nested.currentPeriodEnd?.getTime()).toBe(at * 1000);
      expect(nested.priceId).toBe('price_monthly');
    });

    it('returns nothing rather than 1970 for a missing or zero timestamp', () => {
      expect(readFacts({ data: { object: {} } }).currentPeriodEnd).toBeNull();
      expect(readFacts({ data: { object: { current_period_end: 0 } } }).currentPeriodEnd).toBeNull();
    });

    it('reads an invoice line period, which is where a renewal carries it', () => {
      const facts = readFacts({
        data: { object: { object: 'invoice', customer: 'cus_1', subscription: 'sub_1', lines: { data: [{ period: { end: 1_800_000_000 }, price: { id: 'price_yearly' } }] } } },
      });
      expect(facts.currentPeriodEnd?.getTime()).toBe(1_800_000_000 * 1000);
      expect(facts.priceId).toBe('price_yearly');
      expect(facts.subscriptionId).toBe('sub_1');
    });

    it('survives an object shaped like nothing it knows', () => {
      expect(readFacts({})).toEqual({
        customerId: null,
        subscriptionId: null,
        status: null,
        priceId: null,
        currentPeriodEnd: null,
        orgId: null,
        userId: null,
      });
    });
  });
});
