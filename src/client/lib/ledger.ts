export { formatCents, UNKNOWN_AMOUNT } from './money.js';
import type { EdgeStatus } from '../components/SelvedgeEdge.js';

/**
 * The track-record view rules — pure, so the outcome→edge mapping and the money
 * formatting are testable and identical to the work cards. The record is honest:
 * a miss reads as a miss, never dressed as a win.
 */

export type LedgerOutcome = 'done' | 'declined' | 'stopped' | 'failed';
export type LedgerVerdict = 'verified' | 'probably' | 'inconclusive' | 'didnt_work' | 'stopped' | null;

export type LedgerEntryData = {
  cardId: string;
  projectId: string;
  trigger: 'incident' | 'request';
  intent: string;
  risk: 'sensitive' | 'ordinary' | 'cosmetic';
  outcome: LedgerOutcome;
  verdict: LedgerVerdict;
  spentCents: number;
  at: string;
};

export type LedgerSummaryData = {
  total: number;
  shipped: number;
  spentCents: number;
  byVerdict: Record<string, number>;
  byOutcome: Record<string, number>;
};


/** The edge for a finished change — a clean result is healthy, a miss is dashed unknown, never healthy. */
export function entryEdge(entry: Pick<LedgerEntryData, 'outcome' | 'verdict'>): EdgeStatus {
  if (entry.outcome === 'done' && (entry.verdict === 'verified' || entry.verdict === 'probably')) return 'healthy';
  if (entry.outcome === 'declined') return 'working'; // a deliberate close, not a failure
  return 'unknown'; // stopped, failed, or done-without-a-clean-verdict
}

/** The plain outcome label the owner reads. */
export function outcomeLabel(entry: Pick<LedgerEntryData, 'outcome' | 'verdict'>): string {
  if (entry.outcome === 'done') {
    const v: Record<string, string> = {
      verified: 'Verified',
      probably: 'Probably working',
      inconclusive: "Couldn't fully tell",
      didnt_work: "Didn't work",
    };
    return v[entry.verdict ?? ''] ?? 'Done';
  }
  const o: Record<LedgerOutcome, string> = {
    done: 'Done',
    declined: 'Declined',
    stopped: 'Stopped',
    failed: "Couldn't finish",
  };
  return o[entry.outcome];
}
