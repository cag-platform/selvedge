import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns, handoffReceipts } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { getBuild } from '../build/store.js';
import { costUsd, isPricedModel } from '../llm/pricing.js';
import { composeHandoff, type HandoffPayload, type HandoffRun } from '../handoff/compose.js';
import { agentById, isAgentId, type AgentId } from '../../shared/agents.js';
import { getThread, setThreadAgent, type Thread } from './store.js';
import type { HandoffReceipt } from '../../shared/types/continuation.js';
import { recordProductEvent } from '../telemetry/productEvents.js';
import { defaultChatModelFor } from '../llm/chatModels.js';

/**
 * SWITCHING AGENTS MID-THREAD — the interaction the Inbox exists for.
 *
 * The promise is narrow and testable: the second agent starts where the first
 * one stopped, and the owner explains nothing twice. Everything here serves
 * that, and the parts that could quietly break it are the parts under test.
 *
 * WHO NEEDS A HANDOVER IS DECIDED BY THE INCOMING AGENT, not by what kind of
 * conversation this is — there is no such thing as a kind of conversation any
 * more.
 *
 * An agent that answers over the API reads the whole thread back out of the
 * database on its next turn, so there is nothing to hand it. Nothing is
 * composed and nothing is charged: switching to a talker is free, and the line
 * says so.
 *
 * An agent that changes files cannot: its memory lives in a CLI session inside
 * the sandbox, which cannot see this conversation at all. So the switch
 * composes a handoff (handoff/compose.ts), parks it on the thread as a system
 * line, and the next turn starts the new agent holding it. That is now true
 * whoever it came FROM — including, at last, straight from a conversation
 * where the two of you worked out what to build.
 *
 * THE LINE IS THE FEATURE. `⇄ continued with Codex — handoff 1.8k tokens,
 * about $0.02` is what makes the machinery visible, so it states real numbers:
 * the payload's measured size, and what carrying it costs at the incoming
 * agent's published input rate. When that rate isn't in the pricing table the
 * line says the size and stops — a quoted cost we can't stand behind is worse
 * than no quote, and the turn's real spend lands on its run row regardless.
 */

export type SwitchResult =
  | { ok: true; thread: Thread; changed: boolean; line: string | null; handoff: HandoffPayload | null; receipt: HandoffReceipt | null }
  | { ok: false; reason: 'no_such_thread' | 'unknown_agent'; message: string };

/** What a parked handoff looks like on the thread — the evidence of what was handed over. */
export type SwitchMeta = {
  switch: {
    from: AgentId;
    to: AgentId;
    tokens: number;
    cost_usd: number | null;
    /** The payload itself, waiting for the next turn to spend it. Cleared once spent. */
    payload: string | null;
    pending: boolean;
    receipt_id: string;
  };
};

function isSwitchMeta(meta: unknown): meta is SwitchMeta {
  const value = (meta as SwitchMeta | null)?.switch;
  return Boolean(value && typeof value.pending === 'boolean');
}

/** "1.8k tokens" / "420 tokens" — the size, said the way a person would say it. */
export function saySize(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
}

/**
 * A real cost, said so it can't be mistaken for a free one.
 *
 * The rule this exists for: a handover of a couple of hundred tokens costs a
 * fraction of a cent, and `toFixed(3)` rendered that as "$0.000" — a figure
 * nobody writes, which reads as free while not being free. For a product whose
 * standing rule is that money is never buried, rounding a real charge DOWN to
 * something that looks like zero is the wrong direction to be wrong in. Small
 * amounts are described instead of printed.
 */
export function sayMoney(usd: number): string {
  if (usd <= 0) return 'no charge';
  // Below this it renders as $0.000 — the exact misreading being avoided.
  if (usd < 0.0005) return 'less than a tenth of a cent';
  if (usd < 0.01) return `about $${usd.toFixed(3)}`;
  return `about $${usd.toFixed(2)}`;
}

export function switchLine(from: AgentId, to: AgentId, tokens: number, costUsdValue: number | null): string {
  const name = agentById(to)?.name ?? to;
  if (tokens === 0) return `⇄ continued with ${name} — the conversation so far carries over as it is.`;
  const cost = costUsdValue === null ? '' : `, ${sayMoney(costUsdValue)}`;
  const tail = costUsdValue === null ? ' — its cost lands with the turn.' : '';
  return `⇄ continued with ${name} — handoff ${saySize(tokens)}${cost}${tail}`;
}

/**
 * The same fact as `switchLine`, in the tense of a decision not yet made. The
 * line is a receipt; this is a price tag, and the picker shows it against
 * every name before you touch one.
 */
export function quoteNote(tokens: number, costUsdValue: number | null): string {
  if (tokens === 0) return 'switching is free';
  const carries = `carries ${saySize(tokens)} over`;
  if (costUsdValue === null) return `${carries} — its cost lands with the turn`;
  return `switching costs ${sayMoney(costUsdValue)} · ${carries}`;
}

/** The runs of a thread, in the shape the handoff composer reads them. */
async function runsFor(db: Db, orgId: string, threadId: string): Promise<HandoffRun[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.threadId, threadId)))
    .orderBy(agentRuns.createdAt);
  return rows.map((r) => ({
    kind: r.prompt.startsWith('ship:') ? 'ship' : r.prompt.startsWith('undo:') ? 'undo' : r.prompt.startsWith('plan:') ? 'plan' : 'turn',
    status: r.status,
    costCents: r.costCents,
    commitSha: r.commitSha,
    changedPaths: (r.changedPaths as string[] | null) ?? null,
  }));
}

/**
 * Point a thread at a different agent and leave behind whatever the next turn
 * needs. Returns `changed: false` for a switch to the agent already answering —
 * a no-op that writes nothing, so a double-tap on the picker doesn't litter the
 * conversation with switches that didn't happen.
 */
export async function switchThreadAgent(db: Db, orgId: string, threadId: string, target: string): Promise<SwitchResult> {
  if (!isAgentId(target)) {
    return { ok: false, reason: 'unknown_agent', message: "I don't know that agent." };
  }
  const before = await getThread(db, orgId, threadId);
  if (!before) return { ok: false, reason: 'no_such_thread', message: 'no such thread' };
  if (before.agent === target) return { ok: true, thread: before, changed: false, line: null, handoff: null, receipt: null };

  const from = before.agent as AgentId;
  const switched = await setThreadAgent(db, orgId, threadId, target, defaultChatModelFor(target));
  if (!switched.ok) return { ok: false, reason: switched.reason, message: 'that switch did not go through' };
  const thread = switched.thread;

  const quote = await quoteHandoff(db, orgId, thread, from, target);
  const receipt = await recordHandoffReceipt(db, orgId, thread, from, target, quote.handoff);
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'switch',
    content: quote.line,
    meta: {
      switch: {
        from,
        to: target,
        tokens: quote.tokens,
        cost_usd: quote.costUsd,
        payload: quote.handoff?.text ?? null,
        // Only a real handover waits to be spent; a free switch has nothing
        // parked for the next turn to pick up.
        pending: quote.handoff !== null,
        receipt_id: receipt.id,
      },
    } satisfies SwitchMeta,
  });
  await recordProductEvent(db, orgId, 'agent_switched', { projectId: thread.projectId, threadId: thread.id,
    properties: { from, to: target, handoff_tokens: quote.handoff?.estimated_tokens ?? 0 } });
  return { ok: true, thread, changed: true, line: quote.line, handoff: quote.handoff, receipt };
}

async function recordHandoffReceipt(
  db: Db,
  orgId: string,
  thread: Thread,
  from: AgentId,
  to: AgentId,
  handoff: HandoffPayload | null,
): Promise<HandoffReceipt> {
  const id = ulid();
  const createdAt = new Date();
  const included = handoff
    ? [
        { kind: 'project', count: handoff.sections.project.length },
        { kind: 'story', count: handoff.sections.story.length },
        { kind: 'current_work', count: handoff.sections.standing.length },
        { kind: 'decisions', count: 0 },
        { kind: 'open_questions', count: 0 },
        { kind: 'latest_request', count: handoff.sections.ask ? 1 : 0 },
      ]
    : [{ kind: 'conversation', count: 1, detail: 'The receiving agent reads this thread directly.' }];
  const omitted = handoff?.sections.omitted
    ? [{ kind: 'older_conversation_lines', count: handoff.sections.omitted, reason: 'Summarized to keep the handoff bounded.' }]
    : [];
  const repository = { project_id: thread.projectId, staged_changes_ready: handoff ? handoff.sections.standing.some((line) => line.includes('NOT been shipped')) : null };
  const estimatedTokens = handoff?.estimated_tokens ?? 0;
  const transcriptTokens = handoff?.transcript_tokens ?? 0;
  await db.insert(handoffReceipts).values({
    id, orgId, threadId: thread.id, projectId: thread.projectId, fromAgent: from, toAgent: to,
    included, omitted, repository, estimatedTokens, transcriptTokens,
    payloadHash: handoff ? createHash('sha256').update(handoff.text).digest('hex') : null, createdAt,
  });
  return { id, thread_id: thread.id, from_agent: from, to_agent: to, created_at: createdAt.toISOString(), included, omitted,
    repository, estimated_tokens: estimatedTokens, transcript_tokens: transcriptTokens, destination: receiptDestination(thread.id, id, thread.projectId) };
}

function receiptDestination(threadId: string, receiptId: string, projectId: string | null) {
  return { kind: 'handoff_receipt' as const, web_path: `/inbox/${encodeURIComponent(threadId)}?handoff=${encodeURIComponent(receiptId)}`,
    ios_path: `selvedge://threads/${encodeURIComponent(threadId)}/handoffs/${encodeURIComponent(receiptId)}`,
    ...(projectId ? { project_id: projectId } : {}), thread_id: threadId, receipt_id: receiptId };
}

export async function getHandoffReceipt(db: Db, orgId: string, threadId: string, receiptId: string): Promise<HandoffReceipt | null> {
  const [row] = await db.select().from(handoffReceipts).where(and(
    eq(handoffReceipts.orgId, orgId), eq(handoffReceipts.threadId, threadId), eq(handoffReceipts.id, receiptId),
  )).limit(1);
  if (!row) return null;
  return { id: row.id, thread_id: row.threadId, from_agent: row.fromAgent, to_agent: row.toAgent,
    created_at: row.createdAt.toISOString(), included: row.included as HandoffReceipt['included'], omitted: row.omitted as HandoffReceipt['omitted'],
    repository: row.repository as HandoffReceipt['repository'], estimated_tokens: row.estimatedTokens, transcript_tokens: row.transcriptTokens,
    destination: receiptDestination(row.threadId, row.id, row.projectId) };
}

function shapeReceipt(row: typeof handoffReceipts.$inferSelect): HandoffReceipt {
  return { id: row.id, thread_id: row.threadId, from_agent: row.fromAgent, to_agent: row.toAgent, created_at: row.createdAt.toISOString(),
    included: row.included as HandoffReceipt['included'], omitted: row.omitted as HandoffReceipt['omitted'],
    repository: row.repository as HandoffReceipt['repository'], estimated_tokens: row.estimatedTokens, transcript_tokens: row.transcriptTokens,
    destination: receiptDestination(row.threadId, row.id, row.projectId) };
}

export async function listThreadHandoffReceipts(db: Db, orgId: string, threadId: string): Promise<HandoffReceipt[] | null> {
  const thread = await getThread(db, orgId, threadId);
  if (!thread) return null;
  const rows = await db.select().from(handoffReceipts).where(and(eq(handoffReceipts.orgId, orgId), eq(handoffReceipts.threadId, threadId)))
    .orderBy(desc(handoffReceipts.createdAt));
  return rows.map(shapeReceipt);
}

export async function listProjectHandoffReceipts(db: Db, orgId: string, projectId: string): Promise<HandoffReceipt[]> {
  const rows = await db.select().from(handoffReceipts).where(and(eq(handoffReceipts.orgId, orgId), eq(handoffReceipts.projectId, projectId)))
    .orderBy(desc(handoffReceipts.createdAt));
  return rows.map(shapeReceipt);
}

/**
 * WHAT SWITCHING TO THIS AGENT WOULD COST, right now, without switching.
 *
 * The picker calls this to put a price on each name BEFORE you pick one, and
 * `switchThreadAgent` calls it to do the switching. That is deliberate and it
 * is the whole point of the function existing: a quote and a receipt produced
 * by two different pieces of code will eventually disagree, and the one thing
 * this product cannot afford is a number that turns out to have been a guess.
 */
export type HandoffQuote = {
  tokens: number;
  costUsd: number | null;
  handoff: HandoffPayload | null;
  /** The sentence the thread will show, and the picker shows in advance. */
  line: string;
};

export async function quoteHandoff(
  db: Db,
  orgId: string,
  thread: Thread,
  from: AgentId,
  target: AgentId,
): Promise<HandoffQuote> {
  const free = (): HandoffQuote => ({ tokens: 0, costUsd: null, handoff: null, line: switchLine(from, target, 0, null) });
  const descriptor = agentById(target);
  if (!descriptor) return free();

  // Handing over to a talker costs nothing: the next turn sends this same
  // conversation to a different model, and the history is already in the DB.
  if (!descriptor.changesFiles) return free();

  // A builder needs a project, because that is what a sandbox is built from.
  // There is nothing to compose without one, and the message path says so.
  const projectId = thread.projectId;
  if (!projectId) return free();

  const [pack, build, messages, runs] = await Promise.all([
    getPack(db, orgId, projectId).catch(() => null),
    getBuild(db, orgId, projectId).catch(() => null),
    db
      .select({ role: agentMessages.role, content: agentMessages.content })
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
      .orderBy(agentMessages.createdAt),
    runsFor(db, orgId, thread.id),
  ]);

  const handoff = composeHandoff(
    pack,
    {
      id: thread.id,
      title: thread.title,
      // What the handoff is written FROM: a builder's work reads differently
      // to a conversation, and the composer needs to know which it is.
      kind: agentById(from)?.changesFiles ? 'workshop' : 'general',
      agent: from,
      stagedChangesReady: build?.stagedChangesReady ?? false,
      messages: messages
        .filter((m) => m.role === 'owner' || m.role === 'agent' || m.role === 'activity')
        .map((m) => ({ role: m.role as 'owner' | 'agent' | 'activity', content: m.content })),
      runs,
    },
    target,
  );

  const costUsd_ = isPricedModel(descriptor.pricingModel) ? costUsd(descriptor.pricingModel, handoff.estimated_tokens, 0) : null;
  return {
    tokens: handoff.estimated_tokens,
    costUsd: costUsd_,
    handoff,
    line: switchLine(from, target, handoff.estimated_tokens, costUsd_),
  };

}

/**
 * The handoff a thread is holding for its next turn, if any — and the id of the
 * row holding it, so the caller can mark it spent once it has been sent.
 * Nothing here consumes it: a turn that fails to start must not silently eat
 * the handover, leaving the next agent to begin cold.
 */
export async function pendingHandoff(db: Db, orgId: string, threadId: string): Promise<{ messageId: string; text: string } | null> {
  const [row] = await db
    .select({ id: agentMessages.id, meta: agentMessages.meta })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, threadId), eq(agentMessages.role, 'switch')))
    .orderBy(desc(agentMessages.createdAt))
    .limit(1);
  if (!row || !isSwitchMeta(row.meta)) return null;
  const { pending, payload } = row.meta.switch;
  return pending && payload ? { messageId: row.id, text: payload } : null;
}

/** Mark a parked handoff spent, once the turn that carried it has actually started. */
export async function markHandoffSpent(db: Db, orgId: string, messageId: string): Promise<void> {
  const [row] = await db
    .select({ meta: agentMessages.meta })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, messageId)))
    .limit(1);
  if (!row || !isSwitchMeta(row.meta)) return;
  // The payload text stays: it is the record of exactly what was handed over,
  // and a thread that can't show that can't be checked. Only the flag moves.
  await db
    .update(agentMessages)
    .set({ meta: { switch: { ...row.meta.switch, pending: false } } satisfies SwitchMeta })
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, messageId)));
}
