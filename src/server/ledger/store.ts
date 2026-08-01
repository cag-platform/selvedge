import { and, eq, inArray, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cards } from '../db/schema/index.js';
import type { RiskTier, CostEstimate } from '../cards/types.js';
import { toLedgerEntry, TERMINAL_STATES, type LedgerEntry } from './entries.js';
import { learnedEstimate, type LearnedEstimate } from './costs.js';

/**
 * The ledger read-side over the cards table. It reads finished cards and maps
 * them to entries — org-scoped, newest first. This is what the track record
 * shows and what cost learning reads.
 */
export async function listLedger(db: Db, orgId: string, opts: { projectId?: string; limit?: number } = {}): Promise<LedgerEntry[]> {
  const rows = await db
    .select()
    .from(cards)
    .where(
      opts.projectId
        ? and(eq(cards.orgId, orgId), eq(cards.projectId, opts.projectId), inArray(cards.state, [...TERMINAL_STATES]))
        : and(eq(cards.orgId, orgId), inArray(cards.state, [...TERMINAL_STATES])),
    )
    .orderBy(desc(cards.updatedAt))
    .limit(opts.limit ?? 200);

  // Reuse the domain mapping via listCards' shape would re-query; map rows here.
  const entries: LedgerEntry[] = [];
  for (const row of rows) {
    const entry = toLedgerEntry({
      id: row.id,
      orgId: row.orgId,
      projectId: row.projectId,
      trigger: row.trigger as never,
      title: row.title,
      proposal: row.proposal,
      risk: row.risk as RiskTier,
      gate: row.gate as never,
      estimate: row.estimate as never,
      stop: row.stop as never,
      state: row.state as never,
      verdict: row.verdict as never,
      spentCents: row.spentCents,
      backupVerified: row.backupVerified,
      acts: row.acts as never,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The estimate and cap for a new change of a given risk, learned from this
 * project's own history and falling back to the supplied default until there's
 * enough of it. This is the one call both triggers make, so a repeat change is
 * quoted from what the last ones actually cost.
 */
export async function estimateForChange(
  db: Db,
  orgId: string,
  projectId: string,
  risk: RiskTier,
  fallback: { estimate: CostEstimate; capCents: number },
): Promise<LearnedEstimate> {
  const history = await listLedger(db, orgId, { projectId });
  return learnedEstimate(history, risk, fallback);
}
