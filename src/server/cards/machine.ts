import type { Card, CardAct, CardVerdict, GradedBy } from './types.js';

/**
 * The card state machine — pure. Given a card and an action, it returns the next
 * card or a typed error, and it is the ONLY thing allowed to move a card between
 * states. Two safety properties it exists to guarantee, both learned the hard way:
 *
 *   1. The cap actually stops. Spending that reaches the cap transitions the card
 *      to `stopped` — it is never silently exceeded (the ghost-cap lesson from the
 *      monitor work). Large work also pauses at staged checkpoint fractions
 *      ("40% in, continue?") rather than running to the cap blind.
 *   2. A hard gate cannot be walked through. A sensitive card (payments / auth /
 *      user data) cannot be approved without a verified backup, and no card can
 *      reach `working` without an approval first. Work is never done on an
 *      unapproved, unbacked, sensitive change.
 *
 * Terminal states (`declined`, `stopped`, `done`, `failed`) reject every action.
 */

export type CardAction =
  | { type: 'approve'; at: string; backupVerified?: boolean }
  | { type: 'decline'; at: string; reason?: string }
  | { type: 'start_work'; at: string }
  | { type: 'spend'; at: string; cents: number; detail?: string }
  | { type: 'block'; at: string; reason: string }
  | { type: 'resume'; at: string }
  | { type: 'stop'; at: string; reason?: string }
  | { type: 'begin_verify'; at: string }
  | { type: 'complete'; at: string; verdict: Exclude<CardVerdict, 'stopped'>; gradedBy?: GradedBy; summary?: string; results?: unknown }
  | { type: 'fail'; at: string; reason: string };

export type AdvanceError =
  | 'wrong_state' // the action isn't legal from the card's current state
  | 'backup_required' // a hard-gate card can't be approved without a verified backup
  | 'terminal' // the card is already finished
  | 'bad_amount'; // a spend must be a positive amount

export type AdvanceResult = { ok: true; card: Card } | { ok: false; error: AdvanceError };

const TERMINAL = new Set<Card['state']>(['declined', 'stopped', 'done', 'failed']);

function withAct(card: Card, at: string, act: CardAct): Card {
  return { ...card, acts: [...card.acts, act], updatedAt: at };
}

export function advance(card: Card, action: CardAction): AdvanceResult {
  if (TERMINAL.has(card.state)) return { ok: false, error: 'terminal' };

  switch (action.type) {
    case 'approve': {
      if (card.state !== 'proposed') return { ok: false, error: 'wrong_state' };
      const backupVerified = card.backupVerified || action.backupVerified === true;
      // The hard gate: a sensitive change needs a verified backup to approve.
      if (card.gate === 'hard' && !backupVerified) return { ok: false, error: 'backup_required' };
      const next = withAct({ ...card, backupVerified }, action.at, {
        at: action.at,
        kind: 'approved',
        detail: card.gate === 'hard' ? 'Approved with a verified backup in place.' : 'Approved.',
      });
      return { ok: true, card: { ...next, state: 'approved' } };
    }

    case 'decline': {
      if (card.state !== 'proposed') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'declined', detail: action.reason ?? 'Declined.' });
      return { ok: true, card: { ...next, state: 'declined' } };
    }

    case 'start_work': {
      if (card.state !== 'approved') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'work_started', detail: 'Started work.' });
      return { ok: true, card: { ...next, state: 'working' } };
    }

    case 'spend': {
      if (card.state !== 'working') return { ok: false, error: 'wrong_state' };
      if (!(action.cents > 0)) return { ok: false, error: 'bad_amount' };
      const prevSpent = card.spentCents;
      const newSpent = prevSpent + action.cents;
      const cap = card.stop.capCents;

      // The cap stops. Reaching or exceeding it ends the card, spend recorded.
      if (newSpent >= cap) {
        const next = withAct({ ...card, spentCents: newSpent }, action.at, {
          at: action.at,
          kind: 'cap_reached',
          detail: `Stopped at the cap — spent ${fmt(newSpent)} of a ${fmt(cap)} ceiling.`,
        });
        return { ok: true, card: { ...next, state: 'stopped', verdict: 'stopped' } };
      }

      // A staged checkpoint crossed this spend pauses for the owner.
      const crossed = card.stop.checkpointAtFractions.find((f) => prevSpent < cap * f && cap * f <= newSpent);
      if (crossed !== undefined) {
        const next = withAct({ ...card, spentCents: newSpent }, action.at, {
          at: action.at,
          kind: 'checkpoint',
          detail: `${Math.round(crossed * 100)}% in — ${fmt(newSpent)} of ${fmt(cap)}. Continue?`,
          meta: { fraction: crossed },
        });
        return { ok: true, card: { ...next, state: 'blocked' } };
      }

      return { ok: true, card: { ...card, spentCents: newSpent, updatedAt: action.at } };
    }

    case 'block': {
      if (card.state !== 'working') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'blocked', detail: action.reason });
      return { ok: true, card: { ...next, state: 'blocked' } };
    }

    case 'resume': {
      if (card.state !== 'blocked') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'resumed', detail: 'Continued.' });
      return { ok: true, card: { ...next, state: 'working' } };
    }

    case 'stop': {
      // An owner (or budget) halt, from working or a paused state.
      if (card.state !== 'working' && card.state !== 'blocked') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'stopped', detail: action.reason ?? 'Stopped.' });
      return { ok: true, card: { ...next, state: 'stopped', verdict: 'stopped' } };
    }

    case 'begin_verify': {
      if (card.state !== 'working') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'verifying', detail: 'Checking the change.' });
      return { ok: true, card: { ...next, state: 'verifying' } };
    }

    case 'complete': {
      if (card.state !== 'verifying') return { ok: false, error: 'wrong_state' };
      // Provenance defaults to 'ungraded', never to a stronger claim: a caller
      // that doesn't say who graded gets the weakest answer, not the best one.
      const gradedBy = action.gradedBy ?? 'ungraded';
      const next = withAct(card, action.at, {
        at: action.at,
        kind: 'completed',
        // The honest verdict summary when verification supplied one, else a plain fallback.
        detail: action.summary ?? `Done — ${action.verdict}.`,
        meta: { verdict: action.verdict, gradedBy, ...(action.results !== undefined ? { results: action.results } : {}) },
      });
      return { ok: true, card: { ...next, state: 'done', verdict: action.verdict, gradedBy } };
    }

    case 'fail': {
      if (card.state !== 'working' && card.state !== 'verifying') return { ok: false, error: 'wrong_state' };
      const next = withAct(card, action.at, { at: action.at, kind: 'failed', detail: action.reason });
      return { ok: true, card: { ...next, state: 'failed' } };
    }
  }
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
