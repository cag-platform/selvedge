import type { RiskTier } from '../cards/types.js';
import type { CostEstimate } from '../cards/types.js';
import type { LedgerEntry } from './entries.js';

/**
 * Cost learning from the ledger — the Phase 5 payoff that closes the Phase 3
 * loop. `defaultEstimateAndCap` was a flagged placeholder ("a rough default
 * until the ledger learns real costs"); this is that learning. A new change's
 * estimate and cap come from what comparable past changes on this project
 * actually cost, and fall back to the placeholder only until there's enough
 * history to be honest.
 *
 * The cost class is the risk tier — sensitive changes cost more than cosmetic
 * ones, and that is the split that matters for estimating. Only entries that did
 * real work count; a declined card cost nothing and would drag the estimate to
 * zero.
 */

/** How many comparable past changes before we trust history over the default. */
export const MIN_SAMPLES = 3;
/** The cap is set above the observed high, so a normal run never trips it. */
const CAP_HEADROOM = 1.5;

/** Linear-interpolated percentile over ascending numbers. Empty → 0. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

export type CostClassStats = {
  risk: RiskTier;
  samples: number;
  medianCents: number;
  p90Cents: number;
};

/** The cost distribution for one risk class, over entries that did real work. */
export function costStatsForRisk(entries: LedgerEntry[], risk: RiskTier): CostClassStats {
  const costs = entries
    .filter((e) => e.risk === risk && e.didWork && e.spentCents > 0)
    .map((e) => e.spentCents)
    .sort((a, b) => a - b);
  return {
    risk,
    samples: costs.length,
    medianCents: Math.round(percentile(costs, 50)),
    p90Cents: Math.round(percentile(costs, 90)),
  };
}

export type LearnedEstimate = {
  estimate: CostEstimate;
  capCents: number;
  basis: 'history' | 'default';
  samples: number;
};

/**
 * The estimate and cap for a new change of a given risk. Learned from history
 * when there's enough of it (>= MIN_SAMPLES comparable past changes), otherwise
 * the caller's default. The learned range is p25→p75 of past cost, the cap is
 * p90 with headroom so a typical run never trips it.
 */
export function learnedEstimate(
  entries: LedgerEntry[],
  risk: RiskTier,
  fallback: { estimate: CostEstimate; capCents: number },
): LearnedEstimate {
  const costs = entries
    .filter((e) => e.risk === risk && e.didWork && e.spentCents > 0)
    .map((e) => e.spentCents)
    .sort((a, b) => a - b);

  if (costs.length < MIN_SAMPLES) {
    return { ...fallback, basis: 'default', samples: costs.length };
  }

  const low = Math.round(percentile(costs, 25));
  const high = Math.round(percentile(costs, 75));
  const p90 = percentile(costs, 90);
  // Never propose a cap below the default floor — history should tighten the
  // estimate, not remove the safety margin on a run that happens to spike.
  const capCents = Math.max(fallback.capCents, Math.round(p90 * CAP_HEADROOM));

  return {
    estimate: { lowCents: low, highCents: Math.max(high, low) },
    capCents,
    basis: 'history',
    samples: costs.length,
  };
}
