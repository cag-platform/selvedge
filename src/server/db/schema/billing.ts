import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * WHAT WAS BOUGHT, AND WHAT IT HAS BEEN USED FOR.
 *
 * TENANCY: org, not user. The brief for this work specified a Clerk user id,
 * and every other table in this codebase keys on `org_id` — packs, threads,
 * runs, credentials, usage, ceilings. A solo owner is already the only member
 * of an org, so keying billing on the org costs nothing today and is the only
 * shape the Team tier can have. Keying it on the user would have meant two
 * answers to "whose project is this?", which is how a multi-tenant system
 * starts leaking. The Clerk user who paid is still recorded — `boughtByUserId`
 * — because "who put the card in" is a real question, just not the tenancy one.
 *
 * TWO COLUMNS CALLED PLAN, DELIBERATELY DIFFERENT. `orgs.plan` is
 * 'trial' | 'care' | 'studio' and decides how much of SELVEDGE'S OWN model
 * budget an org may spend per day (llm/budget.ts). `subscriptions.plan` is
 * 'free' | 'pro' | 'team' and decides what the CUSTOMER BOUGHT. They are
 * separate axes and they are not derived from each other. `entitlements.ts` is
 * the only module that reads this one; nothing here should ever be wired into
 * the daily budget without someone deciding, out loud, that the two axes have
 * merged.
 */

/**
 * One row per org. Absent means free — the reader treats a missing row exactly
 * as it treats plan='free', so a signup that raced a webhook is never a locked
 * account.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    /** The Clerk user who bought it. Attribution, never tenancy. */
    boughtByUserId: text('bought_by_user_id'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** 'free' | 'pro' | 'team' — shared/plans.ts. */
    plan: text('plan').notNull().default('free'),
    /** 'active' | 'past_due' | 'canceled' — what Stripe says about the money. */
    status: text('status').notNull().default('active'),
    /** 'monthly' | 'yearly'. Null on free, which is neither. */
    billingInterval: text('billing_interval'),
    /**
     * Subscribed before the pricing_v2 flag flipped, so this price holds through
     * any later raise. A promise made on the landing page, kept in a column.
     */
    grandfatheredPrice: boolean('grandfathered_price').notNull().default(false),
    /** What was paid for, through when. The grace clock and the cancel clock both hang off it. */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_org_idx').on(t.orgId),
    // Webhooks arrive keyed on the customer, sometimes before the app has seen
    // the owner again — so the upsert path needs to find a row by this alone.
    uniqueIndex('subscriptions_stripe_customer_idx').on(t.stripeCustomerId),
  ],
);

/**
 * Build minutes used, per org, per calendar month. `periodStart` is the first
 * of the month in UTC — computed server-side, because a client clock deciding
 * which month a run belongs to is a quota that changes with the timezone.
 *
 * Whole minutes rather than a fraction: every run rounds its wall-clock seconds
 * UP to a minute when it meters, so a fractional column would only ever store
 * whole numbers while implying we track something finer than we do.
 */
export const usageBuildMinutes = pgTable(
  'usage_build_minutes',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    minutesUsed: integer('minutes_used').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('usage_build_minutes_org_period_idx').on(t.orgId, t.periodStart)],
);

/**
 * One row per sandbox we ever start, whether or not anything came of it.
 *
 * Daytona bills wall-clock time, so wall-clock time is what this records: from
 * creation to confirmed stop, not CPU time and not the time an agent was
 * actively working. The row exists so that two things are true — we never lose
 * track of a sandbox we started (the reaper reads this table, not Daytona's),
 * and a sandbox that cost money always lands in the meter, including the ones
 * that ended badly.
 */
export const sandboxRuns = pgTable(
  'sandbox_runs',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    daytonaSandboxId: text('daytona_sandbox_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Confirmed stop. Null while it may still be running — and while it may still be costing. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /**
     * Refreshed by anything that proves the sandbox was alive. The reaper uses
     * it twice: to spot two minutes of nothing, and — when a stop confirmation
     * never arrives — as the honest end time for a run we can no longer ask
     * about. Guessing later would overcharge; guessing `startedAt` would hide
     * money we actually spent.
     */
    lastAliveAt: timestamp('last_alive_at', { withTimezone: true }).notNull().defaultNow(),
    /** Computed on stop. The source of truth for what this run cost in time. */
    wallClockSeconds: integer('wall_clock_seconds'),
    /** 'completed' | 'idle_stop' | 'ceiling_stop' | 'failed' | 'reaper' | 'user_stop' */
    endReason: text('end_reason'),
    /** Set once, guarded, so a double stop meters exactly once. */
    metered: boolean('metered').notNull().default(false),
  },
  (t) => [
    index('sandbox_runs_org_idx').on(t.orgId, t.startedAt),
    // The reaper's query: everything still open, cheaply.
    index('sandbox_runs_open_idx').on(t.endedAt),
    uniqueIndex('sandbox_runs_sandbox_idx').on(t.daytonaSandboxId),
  ],
);

/**
 * Stripe event ids we have already applied. Stripe retries, and a retry that
 * re-applies a handler is how a cancelled subscription comes back to life. The
 * handlers are written to be replay-safe on top of this, not instead of it.
 */
export const stripeEvents = pgTable('stripe_events', {
  /** Stripe's own event id — the whole point is that it is theirs, not ours. */
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
