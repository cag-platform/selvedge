import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { Card } from './types.js';
import { createCard } from './store.js';
import { listCards } from './store.js';
import { incidentWorthCard, incidentSignals, incidentProposal, defaultEstimateAndCap } from './triggers.js';

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
  const { estimate, capCents } = defaultEstimateAndCap(pack.stakes.tier);

  return createCard(db, {
    id: ulid(),
    orgId,
    projectId,
    trigger: 'incident',
    title,
    proposal,
    signals: incidentSignals(pack),
    estimate,
    capCents,
    now: now.toISOString(),
  });
}
