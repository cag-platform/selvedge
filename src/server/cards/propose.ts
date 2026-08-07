import type { Card, CardTrigger, ChangeSignals, CostEstimate, StopPoint } from './types.js';
import { assessRisk } from './risk.js';

/**
 * Assemble a fresh card in `proposed` state — the single entry into the loop,
 * for both triggers. Risk and gate are derived from the change signals here, at
 * proposal time, so the friction a card will demand is fixed before any work and
 * can't drift later.
 *
 * The stop-point defaults its checkpoints from the cap: large work gets staged
 * pauses, small work runs straight through. The caller may override.
 */
export type ProposeInput = {
  id: string;
  orgId: string;
  projectId: string;
  trigger: CardTrigger;
  title: string;
  proposal: string;
  signals: ChangeSignals;
  estimate: CostEstimate;
  capCents: number;
  checkpointAtFractions?: number[];
  now: string; // ISO — injected, never read from the clock here
};

/** Above this ceiling, work is "large" and gets staged checkpoints by default. */
const LARGE_WORK_CENTS = 5000; // $50

export function proposeCard(input: ProposeInput): Card {
  const { risk, gate } = assessRisk(input.signals);

  const checkpointAtFractions =
    input.checkpointAtFractions ?? (input.capCents >= LARGE_WORK_CENTS ? [0.4, 0.75] : []);

  const stop: StopPoint = { capCents: input.capCents, checkpointAtFractions };

  return {
    id: input.id,
    orgId: input.orgId,
    projectId: input.projectId,
    trigger: input.trigger,
    title: input.title,
    proposal: input.proposal,
    risk,
    gate,
    estimate: input.estimate,
    stop,
    state: 'proposed',
    verdict: null,
    gradedBy: null,
    spentCents: 0,
    backupVerified: false,
    acts: [{ at: input.now, kind: 'proposed', detail: input.proposal }],
    createdAt: input.now,
    updatedAt: input.now,
  };
}
