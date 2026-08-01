import type { LedgerEntry } from './entries.js';
import type { CardVerdict, CardState } from '../cards/types.js';

/**
 * The track-record summary — the plain roll-up of what the loop has actually
 * done: how many changes reached the owner, what they cost, and how they turned
 * out. Pure, so the numbers are testable and identical everywhere.
 *
 * "Shipped" is deliberately narrow: only changes that reached a real outcome
 * (verified or probably) count as shipped. A declined proposal, a stopped run,
 * or one that didn't work is in the record — honesty about the misses is the
 * point of a track record — but it is not counted as a win.
 */

export type LedgerSummary = {
  total: number;
  shipped: number; // verified or probably
  spentCents: number;
  byVerdict: Record<string, number>;
  byOutcome: Record<string, number>;
};

const SHIPPED_VERDICTS: ReadonlySet<CardVerdict> = new Set(['verified', 'probably']);

export function summarize(entries: LedgerEntry[]): LedgerSummary {
  const byVerdict: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  let spentCents = 0;
  let shipped = 0;

  for (const e of entries) {
    spentCents += e.spentCents;
    const outcomeKey: CardState = e.outcome;
    byOutcome[outcomeKey] = (byOutcome[outcomeKey] ?? 0) + 1;
    const v = e.verdict ?? 'none';
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    if (e.verdict && SHIPPED_VERDICTS.has(e.verdict)) shipped += 1;
  }

  return { total: entries.length, shipped, spentCents, byVerdict, byOutcome };
}
