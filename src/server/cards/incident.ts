import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { Card } from './types.js';
import { createCard } from './store.js';
import { listCards } from './store.js';
import { classifyRisk } from './risk.js';
import { incidentWorthCard, incidentSignals, incidentProposal, defaultEstimateAndCap } from './triggers.js';
import { listLedger } from '../ledger/store.js';
import { learnedEstimate } from '../ledger/costs.js';
import { priorOccurrence, recallNote } from '../ledger/recall.js';

const TERMINAL = new Set<Card['state']>(['declined', 'stopped', 'done', 'failed']);

/**
 * Propose a fix card from an incident — the proactive front of the loop.
 * Deliberately quiet: it mints at most one open incident card per project, so a
 * flapping outage or a storm of break events doesn't bury the owner in duplicate
 * proposals. Returns the new card, or null when none was minted (not a live app,
 * or a fix is already on the table).
 *
 * It only PROPOSES. The card sits in `proposed` until the owner approves — no
 * work happens here, and for a money-touching app the proposal is already
 * hard-gated (a verified backup is required to approve).
 */
export async function proposeIncidentCard(
  db: Db,
  orgId: string,
  projectId: string,
  pack: ContextPack,
  eventType: string,
  now: Date,
): Promise<Card | null> {
  if (!incidentWorthCard(pack)) return null;

  // One open incident card per project — don't stack proposals.
  const existing = await listCards(db, orgId, projectId);
  if (existing.some((c) => c.trigger === 'incident' && !TERMINAL.has(c.state))) return null;

  const { title, proposal } = incidentProposal(pack, eventType);
  const signals = incidentSignals(pack);

  // One read of this project's history powers both the estimate and the memory.
  const history = await listLedger(db, orgId, { projectId });
  const { estimate, capCents } = learnedEstimate(history, classifyRisk(signals), defaultEstimateAndCap(pack.stakes.tier));

  // "I've seen this before": if we've worked this exact incident before, carry
  // last time's outcome into the proposal so the owner isn't told about a repeat
  // as if it were new.
  const prior = priorOccurrence(history, { intent: title, trigger: 'incident' });
  const fullProposal = prior ? `${proposal}\n\n${recallNote(prior)}` : proposal;

  return createCard(db, {
    id: ulid(),
    orgId,
    projectId,
    trigger: 'incident',
    title,
    proposal: fullProposal,
    signals,
    estimate,
    capCents,
    now: now.toISOString(),
  });
}
