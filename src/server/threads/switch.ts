import { ulid } from 'ulid';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { getBuild } from '../build/store.js';
import { costUsd, isPricedModel } from '../llm/pricing.js';
import { composeHandoff, type HandoffPayload, type HandoffRun } from '../handoff/compose.js';
import { agentById, isAgentId, type AgentId } from '../../shared/agents.js';
import { getThread, setThreadAgent, type Thread } from './store.js';
import type { ThreadKind } from '../../shared/types/thread.js';

/**
 * SWITCHING AGENTS MID-THREAD — the interaction the Inbox exists for.
 *
 * The promise is narrow and testable: the second agent starts where the first
 * one stopped, and the owner explains nothing twice. Everything here serves
 * that, and the parts that could quietly break it are the parts under test.
 *
 * A general thread carries its whole history anyway — it is all API calls, and
 * the next turn simply sends the same conversation to a different model. There
 * is nothing to hand over, so nothing is composed and nothing is charged.
 *
 * A workshop thread cannot: the outgoing agent's memory lives in a CLI session
 * inside the sandbox that the incoming one cannot read. So the switch composes
 * a handoff (handoff/compose.ts), parks it on the thread as a system line, and
 * the next turn starts the new agent with it.
 *
 * THE LINE IS THE FEATURE. `⇄ continued with Codex — handoff 1.8k tokens,
 * about $0.02` is what makes the machinery visible, so it states real numbers:
 * the payload's measured size, and what carrying it costs at the incoming
 * agent's published input rate. When that rate isn't in the pricing table the
 * line says the size and stops — a quoted cost we can't stand behind is worse
 * than no quote, and the turn's real spend lands on its run row regardless.
 */

export type SwitchResult =
  | { ok: true; thread: Thread; changed: boolean; line: string | null; handoff: HandoffPayload | null }
  | { ok: false; reason: 'no_such_thread' | 'unknown_agent' | 'wrong_kind'; message: string };

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

export function switchLine(from: AgentId, to: AgentId, tokens: number, costUsdValue: number | null): string {
  const name = agentById(to)?.name ?? to;
  if (tokens === 0) return `⇄ continued with ${name} — the conversation so far carries over as it is.`;
  const cost = costUsdValue === null ? '' : `, about $${costUsdValue < 0.01 ? costUsdValue.toFixed(3) : costUsdValue.toFixed(2)}`;
  const tail = costUsdValue === null ? ' — its cost lands with the turn.' : '';
  return `⇄ continued with ${name} — handoff ${saySize(tokens)}${cost}${tail}`;
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
  const descriptor = agentById(target)!;
  if (!descriptor.kinds.includes(before.kind as ThreadKind)) {
    const message =
      before.kind === 'workshop'
        ? `${descriptor.name} can chat, but it can't build in a sandbox — start a general thread for it.`
        : `${descriptor.name} builds in a sandbox; this is a chat thread. Start a workshop thread for it.`;
    return { ok: false, reason: 'wrong_kind', message };
  }
  if (before.agent === target) return { ok: true, thread: before, changed: false, line: null, handoff: null };

  const from = before.agent as AgentId;
  const switched = await setThreadAgent(db, orgId, threadId, target, descriptor.pricingModel);
  if (!switched.ok) return { ok: false, reason: switched.reason, message: 'that switch did not go through' };
  const thread = switched.thread;

  // A general thread hands nothing over: the next turn sends the same
  // conversation to a different model, and the history is already in the DB.
  if (thread.kind !== 'workshop') {
    const line = switchLine(from, target, 0, null);
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId: thread.projectId,
      threadId: thread.id,
      role: 'switch',
      content: line,
      meta: { switch: { from, to: target, tokens: 0, cost_usd: null, payload: null, pending: false } } satisfies SwitchMeta,
    });
    return { ok: true, thread, changed: true, line, handoff: null };
  }

  // A workshop thread always has a project — that is what a sandbox is built
  // from — but the column is nullable now, so say so rather than assume it.
  const projectId = thread.projectId;
  if (!projectId) return { ok: true, thread, changed: true, line: null, handoff: null };

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
      kind: 'workshop',
      agent: from,
      stagedChangesReady: build?.stagedChangesReady ?? false,
      messages: messages
        .filter((m) => m.role === 'owner' || m.role === 'agent' || m.role === 'activity')
        .map((m) => ({ role: m.role as 'owner' | 'agent' | 'activity', content: m.content })),
      runs,
    },
    target,
  );

  const priced = isPricedModel(descriptor.pricingModel) ? costUsd(descriptor.pricingModel, handoff.estimated_tokens, 0) : null;
  const line = switchLine(from, target, handoff.estimated_tokens, priced);
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'switch',
    content: line,
    meta: {
      switch: { from, to: target, tokens: handoff.estimated_tokens, cost_usd: priced, payload: handoff.text, pending: true },
    } satisfies SwitchMeta,
  });

  return { ok: true, thread, changed: true, line, handoff };
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
