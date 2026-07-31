import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { llmUsage } from '../db/schema/index.js';

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

export function dailyLlmBudgetUsd(): number {
  const raw = process.env.DAILY_LLM_BUDGET_USD;
  if (raw === undefined) return DEFAULT_DAILY_LLM_BUDGET_USD;
  const parsed = Number(raw);
  // A malformed or negative value must not silently disable the cap.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_LLM_BUDGET_USD;
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
  const capUsd = dailyLlmBudgetUsd();
  const spentUsd = await spendTodayUsd(db, orgId, now);
  return { over: spentUsd >= capUsd, spentUsd, capUsd };
}
