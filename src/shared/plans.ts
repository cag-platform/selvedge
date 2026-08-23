/**
 * THE PLAN TABLE — what each tier includes, in one place, read by both the code
 * that enforces it and the page that sells it.
 *
 * This file exists because of one specific failure: a pricing page that says
 * "60 build minutes" while the server allows 30. Nobody writes that bug on
 * purpose; it arrives when the number lives in two files and only one of them
 * gets edited. So the marketing copy is GENERATED from the same limits the
 * entitlements module reads. Changing a limit changes the landing page in the
 * same commit, or it doesn't change at all.
 *
 * THREE RULES.
 *
 * 1. THE LIMITS ARE THE ONLY TRUTH. `server/billing/entitlements.ts` is the
 *    only module that decides what an org may do, and it decides it from this
 *    table. No route re-implements a limit; no client gates on its own.
 *
 * 2. A LIMIT RESTRICTS VISIBILITY, NEVER DATA. `historyDays` hides; it does not
 *    delete. A downgrade is reversible by paying, which means everything the
 *    owner ever wrote is still there. Export ignores the plan entirely — that
 *    is deliberate and it is a promise, not an oversight.
 *
 * 3. DECLARED IS NOT SOLD. `team` is in the table so the schema and the type
 *    system know about it; `shipped: false` says nobody can buy it yet. Same
 *    pattern as the agent registry's `live` — the seam declares the roadmap,
 *    one flag says what is real today.
 *
 * Plan ids are stored in `subscriptions.plan` and read back forever, so they
 * may be added but never renamed.
 */

export type PlanId = 'free' | 'pro' | 'team';
export type BillingInterval = 'monthly' | 'yearly';

/**
 * What Stripe says about the money, not what the owner may do — those are
 * different questions and `getPlan` is where they meet. `past_due` still
 * carries full access for a grace period, because a card that expired on
 * holiday is not a cancellation.
 */
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';

export type PlanLimits = {
  id: PlanId;
  /** What a person calls it. */
  name: string;
  /** How many projects may be active at once. Null means no limit. */
  projects: number | null;
  /** How far back history is VISIBLE. Null means all of it. Nothing is ever deleted. */
  historyDays: number | null;
  /** Decision briefs are the one feature behind the paywall rather than behind a number. */
  decisionBriefs: boolean;
  /** Sandbox wall-clock minutes included per calendar month. */
  buildMinutes: number;
  /** Can anyone buy this today? */
  shipped: boolean;
  /** USD per month, and per year where a yearly price exists. */
  priceUsd: { monthly: number; yearly: number | null };
  /** Set on a plan sold per seat rather than per org. */
  perSeat: boolean;
};

const PLAN_TABLE = {
  free: {
    id: 'free',
    name: 'Free',
    projects: 2,
    historyDays: 30,
    decisionBriefs: false,
    buildMinutes: 60,
    shipped: true,
    priceUsd: { monthly: 0, yearly: 0 },
    perSeat: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    projects: null,
    historyDays: null,
    decisionBriefs: true,
    buildMinutes: 600,
    shipped: true,
    priceUsd: { monthly: 12, yearly: 115 },
    perSeat: false,
  },
  // Named so the column and the type know it exists. Not sold: there is no
  // seat model, no invites, and no pooled minutes behind it yet, and a plan you
  // can reach but not use is worse than one you can't see.
  team: {
    id: 'team',
    name: 'Team',
    projects: null,
    historyDays: null,
    decisionBriefs: true,
    buildMinutes: 600,
    shipped: false,
    priceUsd: { monthly: 30, yearly: null },
    perSeat: true,
  },
} satisfies Record<PlanId, PlanLimits>;

export const PLANS: readonly PlanLimits[] = Object.values(PLAN_TABLE);

/** The plans anyone can actually buy, in the order they're shown. */
export const SHIPPED_PLANS: readonly PlanLimits[] = PLANS.filter((p) => p.shipped);

export const DEFAULT_PLAN: PlanId = 'free';

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && value in PLAN_TABLE;
}

export function planLimits(id: PlanId): PlanLimits {
  return PLAN_TABLE[id];
}

/**
 * A payment that failed does not lock the owner out the same afternoon. Stripe
 * retries for days; a card expires while somebody is away. Full access holds
 * for this long past the end of the period that was paid for, with a banner
 * saying what happened — after that, entitlements resolve to free and the data
 * sits there waiting.
 */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * How long a subscription id stays meaningful after Stripe says it's gone: not
 * at all. `canceled` keeps the plan until `current_period_end` because that is
 * what was paid for, and resolves to free after. Expressed here so the module
 * and its tests agree on the sentence, not just the number.
 */
export const CANCELED_KEEPS_PLAN_UNTIL_PERIOD_END = true;

// ---------------------------------------------------------------------------
// The selling copy, generated from the limits above.
//
// Everything with a number in it is interpolated. The lines without numbers are
// still here rather than in the page, so that the two cards can never drift
// into describing different products.
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "$12/month", "$0". Money is written the way the ledger writes it. */
export function priceLine(id: PlanId, interval: BillingInterval = 'monthly'): string {
  const plan = planLimits(id);
  const amount = interval === 'yearly' ? plan.priceUsd.yearly : plan.priceUsd.monthly;
  if (amount === null) return 'Not sold yet';
  if (amount === 0) return '$0';
  const per = interval === 'yearly' ? 'year' : 'month';
  return plan.perSeat ? `$${amount}/seat/${per}` : `$${amount}/${per}`;
}

/**
 * How much a year costs against twelve months of the monthly price, said as
 * whole months rather than a percentage — "2 months free" is a thing a person
 * can check; "20% off" is a thing they have to trust.
 */
export function yearlySavingLine(id: PlanId): string | null {
  const { priceUsd } = planLimits(id);
  if (priceUsd.yearly === null || priceUsd.monthly <= 0) return null;
  const monthsFree = Math.floor((priceUsd.monthly * 12 - priceUsd.yearly) / priceUsd.monthly);
  return monthsFree >= 1 ? `${plural(monthsFree, 'month')} free` : null;
}

export function projectsLine(id: PlanId): string {
  const { projects } = planLimits(id);
  return projects === null ? 'Unlimited projects' : `${plural(projects, 'project')}, unlimited subjects`;
}

export function historyLine(id: PlanId): string {
  const { historyDays } = planLimits(id);
  return historyDays === null
    ? 'Full history, search, and provenance timeline'
    : `Last ${plural(historyDays, 'day')} of history visible`;
}

export function buildMinutesLine(id: PlanId): string {
  return `${planLimits(id).buildMinutes} build minutes/month`;
}

/**
 * The card's bullets. Free leads with import because import is the whole reason
 * to arrive; Pro ends with "Everything in Free" so nobody has to compare two
 * lists line by line.
 */
export function planBullets(id: PlanId): string[] {
  const plan = planLimits(id);
  if (plan.id === 'free') {
    return [
      'Import your entire ChatGPT and Claude history',
      projectsLine(id),
      historyLine(id),
      buildMinutesLine(id),
      'Full export, always',
    ];
  }
  return [
    projectsLine(id),
    historyLine(id),
    ...(plan.decisionBriefs ? ['Decision briefs'] : []),
    buildMinutesLine(id),
    'Everything in Free',
  ];
}

export const PLAN_TAGLINE: Record<PlanId, string> = {
  free: 'The trial with no clock.',
  pro: 'Everything, remembered.',
  team: 'For more than one of you.',
};

/**
 * The line under both cards. It is the differentiator and it is also the thing
 * most likely to be mistaken for a catch, so it is said once, plainly, in the
 * same place as the prices rather than in a footnote.
 */
export const BYO_KEYS_LINE =
  'You bring your own AI keys — agent costs are yours at cost, with hard spend ceilings. ' +
  `${priceLine('pro')} covers the record.`;

/**
 * Anyone who subscribes before pricing_v2 keeps this price through any future
 * raise. No countdown, no strikethrough: the urgency is a real promise or it
 * isn't one.
 */
export const FOUNDING_MEMBER_BADGE = `Founding member — ${priceLine('pro')} locked forever`;

/** What the owner is told when a limit stops them, at each of the three friction points. */
export const UPGRADE_PROMPTS = {
  projects: `${projectsLine('free')} on Free. ${priceLine('pro')} lifts the limit.`,
  history: `Older history is locked on Free — locked, never deleted. ${priceLine('pro')} keeps everything.`,
  decisionBriefs: `Decision briefs are part of Pro. ${priceLine('pro')} turns them on.`,
  buildMinutes: `${buildMinutesLine('free')} on Free. ${priceLine('pro')} raises it to ${planLimits('pro').buildMinutes}.`,
} as const;

/** The typed refusals a gated route returns, so the client can react to a code rather than a sentence. */
export type LimitCode = 'limit_projects' | 'limit_history' | 'limit_decision_briefs' | 'limit_build_minutes';
