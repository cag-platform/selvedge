import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cards } from '../db/schema/index.js';
import type { Card, CardVerdict, GradedBy, CostEstimate, StopPoint, CardAct, CardState, RiskTier, GateLevel, CardTrigger } from './types.js';
import { proposeCard, type ProposeInput } from './propose.js';
import { advance, type CardAction, type AdvanceError } from './machine.js';

/**
 * The card store — the ONLY writer of the cards table, and the only bridge
 * between the pure domain and the database. State moves exclusively through
 * `applyAction`, which runs the pure machine and persists its result, so the
 * cap-and-gate guarantees hold against the DB, not just in unit tests.
 *
 * Reads are org-scoped everywhere; a card is fetched by (orgId, id) so one org
 * can never load, list, or act on another's card.
 */

type CardRow = typeof cards.$inferSelect;

function rowToCard(row: CardRow): Card {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    trigger: row.trigger as CardTrigger,
    title: row.title,
    proposal: row.proposal,
    risk: row.risk as RiskTier,
    gate: row.gate as GateLevel,
    estimate: row.estimate as CostEstimate,
    stop: row.stop as StopPoint,
    state: row.state as CardState,
    verdict: (row.verdict as CardVerdict | null) ?? null,
    // Pre-migration rows coalesce to null (no claim), like verdict does.
    gradedBy: (row.gradedBy as GradedBy | null) ?? null,
    spentCents: row.spentCents,
    backupVerified: row.backupVerified,
    acts: row.acts as CardAct[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cardToValues(card: Card) {
  return {
    id: card.id,
    orgId: card.orgId,
    projectId: card.projectId,
    trigger: card.trigger,
    title: card.title,
    proposal: card.proposal,
    risk: card.risk,
    gate: card.gate,
    state: card.state,
    verdict: card.verdict,
    gradedBy: card.gradedBy,
    estimate: card.estimate,
    stop: card.stop,
    spentCents: card.spentCents,
    backupVerified: card.backupVerified,
    acts: card.acts,
    createdAt: new Date(card.createdAt),
    updatedAt: new Date(card.updatedAt),
  };
}

/** Create a proposed card and persist it. Risk/gate are derived at proposal time. */
export async function createCard(db: Db, input: ProposeInput): Promise<Card> {
  const card = proposeCard(input);
  await db.insert(cards).values(cardToValues(card));
  return card;
}

/** Fetch one card, scoped to its org. Null if it doesn't exist for this org. */
export async function getCard(db: Db, orgId: string, cardId: string): Promise<Card | null> {
  const [row] = await db.select().from(cards).where(and(eq(cards.orgId, orgId), eq(cards.id, cardId))).limit(1);
  return row ? rowToCard(row) : null;
}

/** List an org's cards, newest first, optionally filtered to one project. */
export async function listCards(db: Db, orgId: string, projectId?: string): Promise<Card[]> {
  const where = projectId ? and(eq(cards.orgId, orgId), eq(cards.projectId, projectId)) : eq(cards.orgId, orgId);
  const rows = await db.select().from(cards).where(where).orderBy(desc(cards.createdAt));
  return rows.map(rowToCard);
}

export type ApplyResult =
  | { ok: true; card: Card }
  | { ok: false; error: AdvanceError | 'not_found' };

/**
 * The single mutation path: load the card, advance it through the pure machine,
 * and persist the result. A machine rejection (wrong state, backup required,
 * terminal) is returned untouched — the DB write only happens on a legal move.
 */
export async function applyAction(db: Db, orgId: string, cardId: string, action: CardAction): Promise<ApplyResult> {
  const card = await getCard(db, orgId, cardId);
  if (!card) return { ok: false, error: 'not_found' };

  const result = advance(card, action);
  if (!result.ok) return result;

  await db
    .update(cards)
    .set({
      state: result.card.state,
      verdict: result.card.verdict,
      gradedBy: result.card.gradedBy,
      spentCents: result.card.spentCents,
      backupVerified: result.card.backupVerified,
      acts: result.card.acts,
      updatedAt: new Date(result.card.updatedAt),
    })
    .where(and(eq(cards.orgId, orgId), eq(cards.id, cardId)));

  return { ok: true, card: result.card };
}
