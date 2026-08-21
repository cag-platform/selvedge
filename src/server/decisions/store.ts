import { and, desc, eq, or } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, decisionBriefs } from '../db/schema/index.js';
import { freshnessOf, type Freshness } from './freshness.js';
import type { DecisionDraft } from './extract.js';

/**
 * The decision brief store, and the one thing every reader of a brief must go
 * through: `withFreshness`. A brief is never handed out bare, because a brief
 * without its evidence-dating is exactly the object this feature was warned
 * about — a settled-sounding statement whose settledness nobody checked.
 */

export type DecisionBrief = typeof decisionBriefs.$inferSelect;
export type DatedBrief = {
  brief: DecisionBrief;
  freshness: Freshness;
  /** The thinking thread's message count now — what "behind" is counted against. */
  thinkingMessages: number;
};

export async function saveDecision(
  db: Db,
  orgId: string,
  where: { projectId: string | null; thinkingThreadId: string },
  draft: DecisionDraft,
  evidence: { through: Date | null; messages: number },
): Promise<DecisionBrief> {
  const existing = await briefForThinkingThread(db, orgId, where.thinkingThreadId);
  const values = {
    orgId,
    projectId: where.projectId,
    thinkingThreadId: where.thinkingThreadId,
    title: draft.title,
    decision: draft.decision,
    why: draft.why,
    constraints: draft.constraints,
    openQuestions: draft.openQuestions,
    evidenceThrough: evidence.through,
    evidenceMessages: evidence.messages,
    extractedAt: new Date(),
    // A re-extraction replaces the model's words, and with them the record of
    // a human edit: this text is the extraction's again until someone changes it.
    editedAt: null,
    editedByHuman: false,
  };
  if (existing) {
    const [row] = await db.update(decisionBriefs).set(values).where(eq(decisionBriefs.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(decisionBriefs)
    .values({ id: ulid(), ...values })
    .returning();
  return row!;
}

export async function briefForThinkingThread(db: Db, orgId: string, threadId: string): Promise<DecisionBrief | null> {
  const [row] = await db
    .select()
    .from(decisionBriefs)
    .where(and(eq(decisionBriefs.orgId, orgId), eq(decisionBriefs.thinkingThreadId, threadId)))
    .orderBy(desc(decisionBriefs.createdAt))
    .limit(1);
  return row ?? null;
}

/** The brief attached to either half of a pair — the thinking side or the building side. */
export async function briefForThread(db: Db, orgId: string, threadId: string): Promise<DecisionBrief | null> {
  const [row] = await db
    .select()
    .from(decisionBriefs)
    .where(
      and(
        eq(decisionBriefs.orgId, orgId),
        or(eq(decisionBriefs.thinkingThreadId, threadId), eq(decisionBriefs.buildingThreadId, threadId)),
      ),
    )
    .orderBy(desc(decisionBriefs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function getBrief(db: Db, orgId: string, id: string): Promise<DecisionBrief | null> {
  const [row] = await db
    .select()
    .from(decisionBriefs)
    .where(and(eq(decisionBriefs.orgId, orgId), eq(decisionBriefs.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * A brief, always with how far behind the conversation it is. Every caller uses
 * this rather than the row: handing out an undated brief is the mistake this
 * whole feature is built to avoid.
 */
export async function withFreshness(db: Db, orgId: string, brief: DecisionBrief): Promise<DatedBrief> {
  const rows = await db
    .select({ at: agentMessages.createdAt, role: agentMessages.role })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, brief.thinkingThreadId)));
  const spoken = rows.filter((r) => r.role === 'owner' || r.role === 'agent');
  return { brief, freshness: freshnessOf(brief, spoken), thinkingMessages: spoken.length };
}

/** The owner's words replace the extraction's. Editing does NOT re-date it: the evidence is what it saw, not when it was typed. */
export async function editDecision(
  db: Db,
  orgId: string,
  id: string,
  patch: Partial<Pick<DecisionDraft, 'title' | 'decision' | 'why' | 'constraints' | 'openQuestions'>>,
): Promise<DecisionBrief | null> {
  const existing = await getBrief(db, orgId, id);
  if (!existing) return null;
  const [row] = await db
    .update(decisionBriefs)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 120) || existing.title } : {}),
      ...(patch.decision !== undefined ? { decision: patch.decision.trim().slice(0, 4000) || existing.decision } : {}),
      ...(patch.why !== undefined ? { why: patch.why?.trim().slice(0, 1000) || null } : {}),
      ...(patch.constraints !== undefined ? { constraints: patch.constraints.slice(0, 8) } : {}),
      ...(patch.openQuestions !== undefined ? { openQuestions: patch.openQuestions.slice(0, 8) } : {}),
      editedAt: new Date(),
      editedByHuman: true,
    })
    .where(and(eq(decisionBriefs.orgId, orgId), eq(decisionBriefs.id, id)))
    .returning();
  return row ?? null;
}

/** Pair the brief with the thread that will build it. */
export async function attachBuildingThread(db: Db, orgId: string, id: string, buildingThreadId: string): Promise<DecisionBrief | null> {
  const [row] = await db
    .update(decisionBriefs)
    .set({ buildingThreadId })
    .where(and(eq(decisionBriefs.orgId, orgId), eq(decisionBriefs.id, id)))
    .returning();
  return row ?? null;
}

/** The brief as an agent is told it: the decision, its constraints, and — always — what is still open. */
export function briefAsText(brief: DecisionBrief): string {
  const constraints = (brief.constraints as string[] | null) ?? [];
  const open = (brief.openQuestions as string[] | null) ?? [];
  return [
    `WHAT WAS DECIDED — ${brief.title}`,
    brief.decision,
    ...(brief.why ? ['', `Why: ${brief.why}`] : []),
    ...(constraints.length ? ['', 'It must not break:', ...constraints.map((c) => `- ${c}`)] : []),
    // Never omitted. A brief that hides its own gaps is the dangerous kind:
    // the builder fills them in silently and calls the result the decision.
    ...(open.length ? ['', 'Still open — do NOT settle these yourself; ask:', ...open.map((q) => `- ${q}`)] : []),
  ].join('\n');
}
