import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { packs, subscriptions, usageBuildMinutes } from '../db/schema/index.js';
import {
  DEFAULT_PLAN,
  PAST_DUE_GRACE_DAYS,
  UPGRADE_PROMPTS,
  isPlanId,
  planLimits,
  type LimitCode,
  type PlanId,
} from '../../shared/plans.js';

/**
 * THE ONLY MODULE THAT DECIDES WHAT AN ORG MAY DO.
 *
 * Not a convention — a rule with a reason. Entitlement logic that lives in a
 * route lives in exactly one route, and the second route that needs it gets a
 * copy that is subtly kinder or subtly meaner. Then a free account can do a
 * thing through one door and not another, and nobody finds out from the code:
 * they find out from a customer. So every gate in the product asks a question
 * here, and this file asks the plan table in `shared/plans.ts`, which is also
 * what the pricing page renders from. One number, three readers.
 *
 * FOUR RULES.
 *
 * 1. THE CLIENT MAY HIDE; ONLY THE SERVER MAY REFUSE. A blurred panel is a
 *    courtesy. Every route behind it re-asks.
 *
 * 2. A LIMIT RESTRICTS VISIBILITY, NEVER DATA. `historyWindow` returns a floor
 *    for a query. Nothing here deletes, archives, or downgrades a row, and
 *    export never consults this module at all — that is the promise, and it is
 *    kept by there being no call site rather than by a flag somewhere saying
 *    "except export".
 *
 * 3. NO ROW MEANS FREE, NEVER LOCKED. An org that signed up thirty seconds ago
 *    and an org whose webhook is still in flight both read as free and both
 *    work. A missing row is the normal case, not an error.
 *
 * 4. A FAILED PAYMENT IS NOT A CANCELLATION. `past_due` keeps everything for a
 *    grace period with a banner; `canceled` keeps everything until the end of
 *    what was paid for. Both then resolve to free with the data untouched.
 */

export type SubscriptionRow = {
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
};

const dayMs = 24 * 60 * 60 * 1000;

/**
 * What an org is entitled to right now, from the row and the clock alone.
 *
 * Pure, and exported, because this is the function whose edges matter: every
 * state a subscription can be in resolves here, and a test can put it in each
 * one without a database. The db-backed helpers below are all this plus a read.
 */
export function resolvePlan(row: SubscriptionRow | null | undefined, now: Date = new Date()): PlanId {
  if (!row) return DEFAULT_PLAN;
  const plan = isPlanId(row.plan) ? row.plan : DEFAULT_PLAN;
  if (plan === DEFAULT_PLAN) return DEFAULT_PLAN;

  if (row.status === 'active') return plan;

  if (row.status === 'past_due') {
    // The subscription still exists; a charge failed. Full access holds for the
    // grace period past what was paid for.
    //
    // A missing period end resolves in the customer's favour. We would rather
    // give away a week we can't account for than lock a paying owner out of
    // their own record over a timestamp a webhook didn't carry — and the
    // failure is loud on their side either way, because the banner is up.
    if (!row.currentPeriodEnd) return plan;
    return now.getTime() <= row.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * dayMs ? plan : DEFAULT_PLAN;
  }

  if (row.status === 'canceled') {
    // Cancelled, but paid through the end of the period — so it holds until
    // then and not a moment past. No period end means no evidence of paid-for
    // time left, which is the opposite of the past_due case: there the
    // subscription is live, here it is gone.
    if (!row.currentPeriodEnd) return DEFAULT_PLAN;
    return now.getTime() <= row.currentPeriodEnd.getTime() ? plan : DEFAULT_PLAN;
  }

  // A status Stripe invented after this was written. Unknown is not a licence.
  return DEFAULT_PLAN;
}

export async function subscriptionFor(db: Db, orgId: string): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select({ plan: subscriptions.plan, status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/** The plan this org is on today. Every other function here starts with this one. */
export async function getPlan(db: Db, orgId: string, now: Date = new Date()): Promise<PlanId> {
  return resolvePlan(await subscriptionFor(db, orgId), now);
}

/**
 * The shape of a refusal. `code` is what the client switches on; `note` is what
 * a person reads, and it comes from the shared plan table so the sentence in
 * the app and the sentence on the pricing page cannot disagree about the number
 * in the middle of it.
 */
export type Allowance = {
  allowed: boolean;
  code: LimitCode | null;
  /** Null means no limit on this plan. */
  limit: number | null;
  used: number;
  note: string | null;
};

const allow = (limit: number | null, used: number): Allowance => ({ allowed: true, code: null, limit, used, note: null });

/**
 * How many projects count against the limit: every one that isn't permanently
 * deleted, INCLUDING the ones put away.
 *
 * Put away means "not working in this right now" — the project is still
 * watched, still stored, still reachable. If putting one away freed a slot, put
 * away would quietly become the way to run six projects on a two-project plan,
 * and the limit would be a suggestion.
 */
export async function activeProjectCount(db: Db, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(packs)
    .where(and(eq(packs.orgId, orgId), isNull(packs.archivedAt)));
  return Number(row?.n ?? 0);
}

export async function canCreateProject(db: Db, orgId: string, now: Date = new Date()): Promise<Allowance> {
  const { projects } = planLimits(await getPlan(db, orgId, now));
  const used = await activeProjectCount(db, orgId);
  if (projects === null) return allow(null, used);
  return used < projects
    ? allow(projects, used)
    : { allowed: false, code: 'limit_projects', limit: projects, used, note: UPGRADE_PROMPTS.projects };
}

export type HistoryWindow = {
  /** Nothing older than this is shown. Null means show everything. */
  since: Date | null;
  /** The sentence for the lock, or null when there is no lock. */
  note: string | null;
};

/**
 * The date floor for anything that lists the past — threads, the provenance
 * timeline, in-project search.
 *
 * Computed here, server-side, in UTC, from the server's clock. A window a
 * client computes is a window that moves with the traveller's laptop, and a
 * thing that appears and disappears depending on where you opened it is worse
 * than a thing that is simply locked.
 */
export async function historyWindow(db: Db, orgId: string, now: Date = new Date()): Promise<HistoryWindow> {
  const { historyDays } = planLimits(await getPlan(db, orgId, now));
  if (historyDays === null) return { since: null, note: null };
  return { since: new Date(now.getTime() - historyDays * dayMs), note: UPGRADE_PROMPTS.history };
}

export async function canUseDecisionBriefs(db: Db, orgId: string, now: Date = new Date()): Promise<Allowance> {
  const { decisionBriefs } = planLimits(await getPlan(db, orgId, now));
  return decisionBriefs
    ? allow(null, 0)
    : { allowed: false, code: 'limit_decision_briefs', limit: 0, used: 0, note: UPGRADE_PROMPTS.decisionBriefs };
}

/**
 * The first of the month, UTC — the key `usage_build_minutes` is bucketed on.
 *
 * Exported because the meter and the quota must agree about which month a run
 * belongs to, and a run that starts at 23:58 on the 31st meters into the month
 * it STARTED. Two functions computing "this month" separately is how a run
 * lands in a bucket nobody is checking.
 */
export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type BuildMinutes = {
  used: number;
  limit: number;
  remaining: number;
};

export async function buildMinutesThisMonth(db: Db, orgId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ minutes: usageBuildMinutes.minutesUsed })
    .from(usageBuildMinutes)
    .where(and(eq(usageBuildMinutes.orgId, orgId), eq(usageBuildMinutes.periodStart, monthStartUtc(now))))
    .limit(1);
  return Number(row?.minutes ?? 0);
}

/**
 * Minutes left this month. Never negative: a run that overshoots its quota
 * (allowed to finish, up to the thirty-minute ceiling) leaves the meter above
 * the limit, and reporting "-14 remaining" would be arithmetic rather than an
 * answer.
 */
export async function remainingBuildMinutes(db: Db, orgId: string, now: Date = new Date()): Promise<BuildMinutes> {
  const { buildMinutes } = planLimits(await getPlan(db, orgId, now));
  const used = await buildMinutesThisMonth(db, orgId, now);
  return { used, limit: buildMinutes, remaining: Math.max(0, buildMinutes - used) };
}

/**
 * May a NEW sandbox start? Checked at the start of a run and nowhere else.
 *
 * A run that begins with minutes left is allowed to finish even if it crosses
 * zero on the way — the only things that stop a running sandbox are the idle
 * timer and the hard ceiling. Killing a build mid-sentence to save thirty
 * seconds of quota loses the owner's work to save us nothing.
 */
export async function canStartBuild(db: Db, orgId: string, now: Date = new Date()): Promise<Allowance> {
  const plan = await getPlan(db, orgId, now);
  const { buildMinutes } = planLimits(plan);
  const used = await buildMinutesThisMonth(db, orgId, now);
  if (used < buildMinutes) return allow(buildMinutes, used);

  // Same refusal either way; different sentence. Pro's cap is fair-use, not a
  // meter that starts billing — so it says who to talk to rather than what to
  // buy, and nothing auto-charges for going over.
  const note =
    plan === DEFAULT_PLAN
      ? UPGRADE_PROMPTS.buildMinutes
      : `That's ${buildMinutes} build minutes this month, which is the fair-use mark on Pro. Nothing has been charged — email us and we'll sort it out.`;
  return { allowed: false, code: 'limit_build_minutes', limit: buildMinutes, used, note };
}

/**
 * Everything the billing screen and the upgrade prompts need, in one read
 * rather than five. Same answers as the functions above, by construction —
 * they are what it calls.
 */
export type Entitlements = {
  plan: PlanId;
  projects: Allowance;
  history: HistoryWindow;
  decisionBriefs: Allowance;
  buildMinutes: BuildMinutes;
};

export async function entitlementsFor(db: Db, orgId: string, now: Date = new Date()): Promise<Entitlements> {
  const plan = await getPlan(db, orgId, now);
  const [projects, decisionBriefs, buildMinutes] = await Promise.all([
    canCreateProject(db, orgId, now),
    canUseDecisionBriefs(db, orgId, now),
    remainingBuildMinutes(db, orgId, now),
  ]);
  const { historyDays } = planLimits(plan);
  return {
    plan,
    projects,
    history:
      historyDays === null
        ? { since: null, note: null }
        : { since: new Date(now.getTime() - historyDays * dayMs), note: UPGRADE_PROMPTS.history },
    decisionBriefs,
    buildMinutes,
  };
}
