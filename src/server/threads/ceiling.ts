import { and, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { defaultEstimateAndCap } from '../cards/triggers.js';
import type { Thread } from './store.js';

/**
 * THE SPEND CEILING ON A CONVERSATION.
 *
 * Selvedge's central sentence is that you are asked, never surprised, and
 * nothing spends past what you approved. That was true of a work card — which
 * carries an estimate, a hard cap and checkpoint pauses — and it was NOT true
 * of a conversation, which could take build turn after build turn with nothing
 * stopping it. The Inbox made conversations the primary way to work, so the
 * promise held on the path people didn't use and not on the one they did.
 *
 * This closes that. The policy is deliberately the SAME function the cards
 * use (`defaultEstimateAndCap`), so the two cannot drift into disagreeing
 * about what a project's stakes are worth.
 *
 * THE CEILING IS A PAUSE, NOT A WALL. Hitting it stops the next turn and says
 * so with the real number in it; one word carries on, to another cap's worth.
 * The raise is recorded on the conversation, because a ceiling nobody can see
 * being lifted is the same as no ceiling at all.
 */
export type SpendCeiling = {
  spentCents: number;
  /** What this conversation may spend before it stops to ask again. */
  capCents: number;
  /** How many times the owner has said carry on. */
  raises: number;
  /** Would the next turn be spending past what was agreed? */
  reached: boolean;
  /** The sentence to put in front of the owner. Empty when there's nothing to say. */
  note: string;
};

/** The mark a raise leaves. Counting these IS the state — no column to drift. */
const RAISE_MARK = 'spend-ceiling-raised';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function threadCeiling(db: Db, orgId: string, thread: Thread): Promise<SpendCeiling> {
  const [[spend], raiseRows, pack] = await Promise.all([
    db
      .select({ cents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)` })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.threadId, thread.id))),
    db
      .select({ meta: agentMessages.meta })
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id), eq(agentMessages.role, 'switch'))),
    thread.projectId ? getPack(db, orgId, thread.projectId).catch(() => null) : Promise.resolve(null),
  ]);

  const spentCents = Number(spend?.cents ?? 0);
  const raises = raiseRows.filter((r) => (r.meta as { kind?: string } | null)?.kind === RAISE_MARK).length;

  // No pack means no stated stakes, so the gentlest ceiling applies rather
  // than none: an unknown project is not a licence to spend.
  const base = defaultEstimateAndCap(pack?.stakes.tier ?? 'sandbox').capCents;
  const capCents = base * (raises + 1);
  const reached = spentCents >= capCents;

  return {
    spentCents,
    capCents,
    raises,
    reached,
    note: reached
      ? `This conversation has spent ${money(spentCents)}, which is where I said I'd stop. Nothing is lost and nothing is undone — say the word and I'll carry on up to ${money(capCents + base)}.`
      : '',
  };
}

/**
 * Record that the owner said carry on, and by how much. Written as a system
 * line on the conversation so the raise is part of the record the export
 * carries — the ledger of what was agreed to, not just what was spent.
 */
export async function raiseCeiling(db: Db, orgId: string, thread: Thread, ceiling: SpendCeiling): Promise<void> {
  const next = ceiling.capCents + ceiling.capCents / (ceiling.raises + 1);
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'switch',
    content: `⇄ you asked me to carry on past ${money(ceiling.capCents)} — this conversation now stops at ${money(next)}.`,
    meta: { kind: RAISE_MARK, from_cents: ceiling.capCents, to_cents: next },
  });
}
