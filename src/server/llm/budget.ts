import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { llmUsage, orgs } from '../db/schema/index.js';

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

/** Model spend recorded for this org since UTC midnight. Counts failed calls too — they cost money. */
export async function spendTodayUsd(db: Db, orgId: string, now: Date = new Date()): Promise<number> {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.orgId, orgId), gte(llmUsage.createdAt, midnight)));
  return Number(row?.total ?? 0);
}

export type BudgetState = { over: boolean; spentUsd: number; capUsd: number };

/**
 * The gate every model call path consults. Returns the numbers as well as the
 * verdict so callers can record *why* they degraded rather than leaving a
 * silent behaviour change.
 */
export async function checkDailyBudget(db: Db, orgId: string, now: Date = new Date()): Promise<BudgetState> {
  const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  const capUsd = dailyLlmBudgetUsd(org?.plan);
  const spentUsd = await spendTodayUsd(db, orgId, now);
  return { over: spentUsd >= capUsd, spentUsd, capUsd };
}
