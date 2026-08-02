import { and, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { llmUsage, orgs } from '../db/schema/index.js';
import type { LlmPurpose } from './types.js';

/**
 * The daily model-spend cap, per org — a cap that actually stops.
 *
 * Why this exists rather than another advisory number: three separate spend
 * guards across this codebase and its siblings were shipped inert. Toile's
 * daily cap had its enforcement deleted while the slider, the "then stops"
 * copy and the 80% warning all survived; SILD's AI budget was doubly
 * disabled; and `DAILY_BUDGET_USD` here coloured an admin row and blocked
 * nothing. A limit that is displayed but not enforced is worse than no limit,
 * because it reassures.
 *
 * The enforcement is deliberately graceful rather than fatal. Exceeding the
 * cap does not error and does not silence the product — it drops the org to
 * the deterministic path for the rest of the day: template narration and a
 * mechanical brief. The brief always sends. That is the same degradation the
 * product already performs when the model is unreachable, so the failure mode
 * is one that is tested on every other path too.
 *
 * The default is a placeholder chosen to be generous for narration and
 * composition work (a fragment costs fractions of a cent; the daily brief is
 * one call per org). Set DAILY_LLM_BUDGET_USD per plan once real usage exists
 * — this number should be a product decision, not a constant nobody revisits.
 */
export const DEFAULT_DAILY_LLM_BUDGET_USD = 1.0;

/**
 * The cap belongs to the plan, not to the deployment. A trial account and a
 * Studio account should not share one number, and the number a customer is
 * held to has to be one they were sold.
 *
 * These are placeholders sized for narration and composition only — a
 * fragment costs fractions of a cent and the daily brief is one call. Repair
 * work in Phase 3 gets its own, larger allowance rather than sharing this;
 * mixing "explain my app" spend with "change my app" spend in one number
 * would let a busy morning of briefs eat the budget for a fix.
 */
export const PLAN_DAILY_LLM_BUDGET_USD: Record<string, number> = {
  trial: 0.25,
  care: 1.0,
  studio: 4.0,
};

/**
 * Resolve the cap for a plan. The environment variable remains as a
 * deployment-wide override for dogfooding and tests; an unknown plan falls
 * back to the safe default rather than to "no limit".
 */
export function dailyLlmBudgetUsd(plan?: string): number {
  const raw = process.env.DAILY_LLM_BUDGET_USD;
  if (raw !== undefined) {
    const parsed = Number(raw);
    // A malformed or negative value must not silently disable the cap.
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (plan && plan in PLAN_DAILY_LLM_BUDGET_USD) return PLAN_DAILY_LLM_BUDGET_USD[plan] as number;
  return DEFAULT_DAILY_LLM_BUDGET_USD;
}

/**
 * The purposes that belong to Sketch rather than to the watching. Kept as a
 * list so the split stays one edit if thinking-side work grows a second
 * purpose.
 */
export const SKETCH_PURPOSES: LlmPurpose[] = ['sketch'];

/**
 * Sketch's own daily allowance, deliberately separate from the watching's.
 *
 * This is the split the note above calls for. Sketch is the chattiest surface
 * in the product — many turns, growing context — and the daily brief is the
 * product. If they shared one number, an afternoon of thinking would silently
 * turn tomorrow morning's brief mechanical. So sketching gets its own budget,
 * and its spend is excluded from the watching's cap entirely: neither can
 * starve the other.
 *
 * Sized against real numbers: a Sketch turn on sonnet costs roughly $0.02, so
 * these buy about 25 / 100 / 400 turns a day.
 */
export const PLAN_DAILY_SKETCH_BUDGET_USD: Record<string, number> = {
  trial: 0.5,
  care: 2.0,
  studio: 8.0,
};

export const DEFAULT_DAILY_SKETCH_BUDGET_USD = 2.0;

export function dailySketchBudgetUsd(plan?: string): number {
  const raw = process.env.SKETCH_DAILY_BUDGET_USD;
  if (raw !== undefined) {
    const parsed = Number(raw);
    // Same rule as the watching's cap: malformed or negative never means "no limit".
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (plan && plan in PLAN_DAILY_SKETCH_BUDGET_USD) return PLAN_DAILY_SKETCH_BUDGET_USD[plan] as number;
  return DEFAULT_DAILY_SKETCH_BUDGET_USD;
}

/**
 * Model spend recorded for this org since UTC midnight. Counts failed calls
 * too — they cost money. `only` / `except` narrow it to one side of the
 * sketch/watching split; passing neither counts everything.
 */
export async function spendTodayUsd(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  scope: { only?: LlmPurpose[]; except?: LlmPurpose[] } = {},
): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const filters = [eq(llmUsage.orgId, orgId), gte(llmUsage.createdAt, midnight)];
  if (scope.only?.length) filters.push(inArray(llmUsage.purpose, scope.only));
  if (scope.except?.length) filters.push(notInArray(llmUsage.purpose, scope.except));
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(and(...filters));
  return Number(row?.total ?? 0);
}

export type BudgetState = { over: boolean; spentUsd: number; capUsd: number };

/**
 * The gate every model call path consults. Returns the numbers as well as the
 * verdict so callers can record *why* they degraded rather than leaving a
 * silent behaviour change.
 *
 * Sketch spend is excluded: this cap guards the watching, and the watching
 * must not go mechanical because someone spent the afternoon thinking.
 */
export async function checkDailyBudget(db: Db, orgId: string, now: Date = new Date()): Promise<BudgetState> {
  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  const capUsd = dailyLlmBudgetUsd(org?.plan);
  const spentUsd = await spendTodayUsd(db, orgId, now, { except: SKETCH_PURPOSES });
  return { over: spentUsd >= capUsd, spentUsd, capUsd };
}

/** The same gate for Sketch, against Sketch's own allowance and its own spend. */
export async function checkSketchBudget(db: Db, orgId: string, now: Date = new Date()): Promise<BudgetState> {
  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  const capUsd = dailySketchBudgetUsd(org?.plan);
  const spentUsd = await spendTodayUsd(db, orgId, now, { only: SKETCH_PURPOSES });
  return { over: spentUsd >= capUsd, spentUsd, capUsd };
}
