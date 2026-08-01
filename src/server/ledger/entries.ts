import type { Card, CardState, CardTrigger, CardVerdict, RiskTier } from '../cards/types.js';

/**
 * The intent→outcome ledger (BUILD-BRIEF Phase 5). Every finished card is one
 * append-only record of what was asked, what it cost, and how it turned out.
 * The card table already IS the ledger — nothing is duplicated; this is the
 * read-side view of it, the shape the track record and the cost-learning read.
 *
 * The point of the ledger is the flywheel: the second occurrence is measurably
 * cheaper than the first, because the estimate for a new change is learned from
 * the real cost of the ones before it (see costs.ts).
 */

export const TERMINAL_STATES: ReadonlySet<CardState> = new Set(['done', 'declined', 'stopped', 'failed']);

export function isTerminal(state: CardState): boolean {
  return TERMINAL_STATES.has(state);
}

export type LedgerEntry = {
  cardId: string;
  projectId: string;
  trigger: CardTrigger;
  /** What was asked, in the owner's words. */
  intent: string;
  risk: RiskTier;
  outcome: CardState; // done | declined | stopped | failed
  verdict: CardVerdict | null;
  spentCents: number;
  /** Whether real work happened — a declined card is intent with no work. */
  didWork: boolean;
  at: string; // when it finished (updatedAt)
};

/** Map a finished card to its ledger entry. Non-terminal cards have no entry yet. */
export function toLedgerEntry(card: Card): LedgerEntry | null {
  if (!isTerminal(card.state)) return null;
  return {
    cardId: card.id,
    projectId: card.projectId,
    trigger: card.trigger,
    intent: card.title,
    risk: card.risk,
    outcome: card.state,
    verdict: card.verdict,
    spentCents: card.spentCents,
    // A declined card never started; anything that spent, or reached done/failed
    // after work, counts as real work for cost learning.
    didWork: card.state !== 'declined',
    at: card.updatedAt,
  };
}
