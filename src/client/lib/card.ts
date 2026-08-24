export { formatCents, formatRange, UNKNOWN_AMOUNT } from './money.js';
import type { EdgeStatus } from '../components/SelvedgeEdge.js';

/**
 * The owner-facing view rules for a work card — pure, so the "read the edge"
 * thesis and the money/label formatting are testable without a DOM. The server
 * owns the machine; this only decides how a card LOOKS.
 */

export type CardState =
  | 'proposed' | 'approved' | 'working' | 'blocked' | 'verifying' | 'done' | 'declined' | 'stopped' | 'failed';
export type CardVerdict = 'verified' | 'probably' | 'inconclusive' | 'didnt_work' | 'stopped';
export type GradedBy = 'independent' | 'same_model' | 'ungraded';
export type RiskTier = 'sensitive' | 'ordinary' | 'cosmetic';
export type GateLevel = 'hard' | 'normal' | 'frictionless';

export type CardAct = { at: string; kind: string; detail: string; meta?: Record<string, unknown> };

export type WorkCardData = {
  id: string;
  projectId: string;
  trigger: 'incident' | 'request';
  title: string;
  proposal: string;
  risk: RiskTier;
  gate: GateLevel;
  estimate: { lowCents: number; highCents: number };
  stop: { capCents: number; checkpointAtFractions: number[] };
  state: CardState;
  verdict: CardVerdict | null;
  gradedBy: GradedBy | null;
  spentCents: number;
  backupVerified: boolean;
  acts: CardAct[];
  createdAt: string;
  updatedAt: string;
};

/** The two states that need the owner right now. */
export function needsOwner(state: CardState): boolean {
  return state === 'proposed' || state === 'blocked';
}

/**
 * Running rather than waiting. The complement of `needsOwner` among the states
 * that are still open — what belongs in "in motion" rather than in front of
 * your face. Every other state is closed, and belongs in History.
 */
export function inMotion(state: CardState): boolean {
  return state === 'approved' || state === 'working' || state === 'verifying';
}

/**
 * The card's edge. Needs-you states wear the one thread edge; in-motion states
 * are brass; a clean finish is healthy; anything that ended without a clean
 * result (inconclusive, stopped, failed, declined) is dashed unknown — never
 * dressed as healthy.
 */
export function cardEdge(state: CardState, verdict: CardVerdict | null): EdgeStatus {
  switch (state) {
    case 'proposed':
    case 'blocked':
      return 'needs';
    case 'approved':
    case 'working':
    case 'verifying':
      return 'working';
    case 'done':
      return verdict === 'verified' || verdict === 'probably' ? 'healthy' : 'unknown';
    default:
      return 'unknown'; // stopped, failed, declined — closed without a clean result
  }
}

const STATE_LABEL: Record<CardState, string> = {
  proposed: 'Needs your OK',
  approved: 'Approved',
  working: 'Working on it',
  blocked: 'Paused — needs you',
  verifying: 'Checking the change',
  done: 'Done',
  declined: 'Declined',
  stopped: 'Stopped',
  failed: "Couldn't finish",
};

export function stateLabel(state: CardState, verdict: CardVerdict | null): string {
  if (state === 'done' && verdict) {
    const v: Record<CardVerdict, string> = {
      verified: 'Done — verified',
      probably: 'Done — probably working',
      inconclusive: "Done — I can't fully tell",
      didnt_work: "Done — it didn't work",
      stopped: 'Stopped',
    };
    return v[verdict];
  }
  return STATE_LABEL[state];
}

/**
 * The provenance line under a finished card's verdict — the sentence the
 * verifier exists to make true. Shown ONLY for an independent grade: a
 * same-model grade or no grade says nothing rather than something weaker
 * dressed as reassurance, and the verdict itself already carries the honest
 * ceiling ("probably", not "verified") in those cases.
 */
export function graderNote(state: CardState, gradedBy: GradedBy | null): string | null {
  if (state !== 'done' || gradedBy !== 'independent') return null;
  return 'Checked by a different model than the one that wrote it.';
}



/**
 * The plain gate note shown at approval. A hard gate says, in words, why the
 * backup is required — the SILD lesson made legible, never jargon.
 */
export function gateNote(risk: RiskTier): string | null {
  switch (risk) {
    case 'sensitive':
      return 'This touches something sensitive — payments, logins, or customer data. I need you to confirm a recent backup before I make the change.';
    case 'cosmetic':
      return 'This is a copy or styling change — low risk.';
    case 'ordinary':
      return null;
  }
}
