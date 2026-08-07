/**
 * The card grammar (BUILD-BRIEF Phase 3, SELVEDGE-VIABILITY-REVIEW accord §1).
 *
 * Every ask returns the SAME card, whether it's a $6 fix or a $200 feature and
 * whether Selvedge raised it (an incident it can fix) or the owner asked for it:
 * a plain-English proposal, an estimate, a stop-point, and an approval. There is
 * no builder mode and no second tab — one grammar, one path.
 *
 * The loop the card walks: propose → estimate → cap → approve → work → verify.
 * This module is the pure domain: the shape of a card, the risk classification
 * (SILD's money-critical / terminology / stylistic pattern applied to code), and
 * the state machine live alongside in risk.ts and machine.ts. No DB, no agent,
 * no network — so the governance that keeps AI code-change safe is testable in
 * isolation, which is exactly the part that must never be wrong.
 */

/** Who initiated the card. Both triggers walk the identical loop. */
export type CardTrigger = 'incident' | 'request';

/**
 * SILD's governance tiers, applied to code changes. The tier is a fact about
 * what the change TOUCHES, decided before any work — not a guess about how it
 * will go.
 */
export type RiskTier = 'sensitive' | 'ordinary' | 'cosmetic';

/**
 * How much friction the risk tier demands at approval:
 *   hard         → sensitive changes (payments, auth, user data): an explicit
 *                  approval that REQUIRES a verified backup first.
 *   normal       → ordinary logic: a normal approval.
 *   frictionless → copy/styling: still a card and still an estimate, but approval
 *                  is a single tap (or pre-authorized).
 */
export type GateLevel = 'hard' | 'normal' | 'frictionless';

/**
 * The lifecycle. Terminal states are `declined`, `stopped`, `done`, and
 * `failed`. `blocked` is a pause for owner input mid-work, not an end.
 */
export type CardState =
  | 'proposed'
  | 'approved'
  | 'working'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'declined'
  | 'stopped'
  | 'failed';

/** The five-value verdict (Phase 4), declared here so the machine can carry it. */
export type CardVerdict = 'verified' | 'probably' | 'inconclusive' | 'didnt_work' | 'stopped';

/**
 * Who graded the acceptance behind a verdict.
 *   independent → a model on a DIFFERENT provider than authored the change
 *                 read the diff and judged it. The claim the product makes.
 *   same_model  → a grader ran, but on the author's own provider. Disclosed,
 *                 never dressed up as independent.
 *   ungraded    → no grader ran; the verdict rests on the deterministic checks
 *                 alone, which is why it tops out at `probably`.
 */
export type GradedBy = 'independent' | 'same_model' | 'ungraded';

/** A money range, in whole US cents to avoid float drift. Inclusive. */
export type CostEstimate = {
  lowCents: number;
  highCents: number;
};

/**
 * The stop-point: where work halts on its own. `capCents` is the hard ceiling
 * (never silently exceeded — the ghost-cap lesson). For large work, `checkpoints`
 * are the staged "40% in, $58 of $150, continue?" pauses.
 */
export type StopPoint = {
  capCents: number;
  /** Fractions of the cap at which to pause and ask (e.g. [0.4, 0.75]); empty for small work. */
  checkpointAtFractions: number[];
};

/**
 * What the risk classifier was told about the change. These are structured
 * facts (from the pack, the incident, or the parsed request), never a free-text
 * guess — a wrong "this is just copy" on an auth change is the unforgivable miss.
 */
export type ChangeSignals = {
  touchesPayments?: boolean;
  touchesAuth?: boolean;
  touchesUserData?: boolean;
  /** The change is confined to copy/styling/content with no logic. */
  cosmeticOnly?: boolean;
};

/** One recorded act in the card's history — the append-only spine of the ledger (Phase 5). */
export type CardAct = {
  at: string; // ISO
  kind: string; // 'proposed' | 'approved' | 'work_started' | 'checkpoint' | 'verified' | ...
  detail: string; // plain-English line
  meta?: Record<string, unknown>;
};

export type Card = {
  id: string;
  orgId: string;
  projectId: string;
  trigger: CardTrigger;
  /** One plain sentence naming the change, no jargon. */
  title: string;
  /** The proposal in plain English: what I'd do and why. */
  proposal: string;
  risk: RiskTier;
  gate: GateLevel;
  estimate: CostEstimate;
  stop: StopPoint;
  state: CardState;
  /** Set once the card reaches a verdict. */
  verdict: CardVerdict | null;
  /** Who graded the acceptance behind it. Set with the verdict; null before. */
  gradedBy: GradedBy | null;
  /** Spent so far against the cap, in cents. */
  spentCents: number;
  /** Whether a verified backup exists — required to approve a hard-gate card. */
  backupVerified: boolean;
  acts: CardAct[];
  createdAt: string;
  updatedAt: string;
};
