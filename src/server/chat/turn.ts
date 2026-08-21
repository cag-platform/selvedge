import { ulid } from 'ulid';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { healthLine } from '../packs/healthLine.js';
import { checkThinkingBudget } from '../llm/budget.js';
import { chatModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';
import type { LlmClient } from '../llm/types.js';
import { agentById, type AgentId } from '../../shared/agents.js';
import type { Thread } from '../threads/store.js';

/**
 * A general thread's turn: plain conversation, no sandbox, nothing to ship.
 *
 * This is the half of the Inbox that isn't building — thinking a change
 * through, deciding what to do, asking what something means — and the reason it
 * lives inside Selvedge rather than in a chat app is that here it joins the
 * record: attached to the project it's about, costed in the same ledger,
 * exportable with everything else. A decision made in a chat app is lost the
 * moment the tab closes; a decision made here is still there in six months,
 * next to the work it produced.
 *
 * It runs on the existing LLM seam — structured output, one `reply` string —
 * so it inherits metering, the budget gate and the provider seam without a new
 * network path. The thread's agent chooses the provider; a thread whose
 * provider isn't connected says so plainly instead of quietly answering as
 * somebody else.
 */

export type ChatOutcome =
  | { ok: true; reply: string; model: string; costed: true }
  | { ok: false; reason: 'no_fuel' | 'over_budget' | 'model_failed'; message: string };

/** Bounds — the context must not grow without limit as a thread gets long. */
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1500;
const MAX_REPLY_TOKENS = 900;

const CHAT_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
  additionalProperties: false,
} as const;

const SYSTEM = `You are Selvedge, talking with the owner of a small software project.

This is a thinking conversation, not a building one: no code is being written here
and nothing you say ships. Help them think — about what to build, what it would
cost, what could go wrong, whether an idea is worth it at all.

How to talk:
- Plain English, the owner's own words for their app. They may not read code.
- Short. A paragraph, not a report. No headings unless they asked for a list.
- Say what you would do and why, rather than laying out every option.

What you must not do:
- Never state anything about the CURRENT state of their app that isn't in the
  context below. You cannot see their live app from here; if they ask whether
  something is broken or deployed, say plainly that you can't see that from this
  conversation. A confident, wrong "it's fine" is the worst thing you can say.
- Never invent history, numbers, or events.
- Never hand over commands, install steps, or setup checklists — they have no
  terminal. Building happens in a workshop thread, where an agent does it.`;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The provider a thread's agent runs on, or null when the agent isn't a chat agent. */
export function chatProviderFor(agent: AgentId): 'anthropic' | 'openai' | null {
  const descriptor = agentById(agent);
  if (!descriptor || !descriptor.kinds.includes('general')) return null;
  return descriptor.provider;
}

/** The plainest true description of the project a thread hangs off. Null when there's no pack. */
async function projectContext(db: Db, orgId: string, projectId: string): Promise<Record<string, unknown> | null> {
  const pack = await getPack(db, orgId, projectId).catch(() => null);
  if (!pack) return null;
  return {
    name: pack.identity.name,
    what_it_is: clip(pack.identity.owner_description, 400),
    stakes: pack.stakes.tier,
    handles_money: pack.stakes.touches_money,
    ...(pack.topology.stack_summary ? { built_with: clip(pack.topology.stack_summary, 200) } : {}),
    // The same sentence the brief and the project card show, so the chat can
    // never disagree with the rest of the product about how the app is doing.
    plain_status: healthLine(pack),
  };
}

async function say(db: Db, orgId: string, thread: Thread, content: string): Promise<void> {
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'agent',
    content,
  });
}

/**
 * One turn of a general thread. The owner's message lands first (the
 * conversation is the record even when the answer fails), then the model call,
 * then the reply — or an honest line about why there isn't one.
 */
export async function runChatTurn(
  db: Db,
  orgId: string,
  thread: Thread,
  ownerText: string,
  deps: { client?: LlmClient | null; now?: () => Date } = {},
): Promise<ChatOutcome> {
  const now = deps.now ?? (() => new Date());
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'owner',
    content: ownerText,
  });

  const provider = chatProviderFor(thread.agent as AgentId);
  if (!provider || !deps.client) {
    const name = agentById(thread.agent as AgentId)?.name ?? thread.agent;
    const message = `This thread runs on ${name}, and there's no key connected for it — so I can't answer here yet. Connect one under Connections, or switch this thread to a model you have connected.`;
    await say(db, orgId, thread, message);
    return { ok: false, reason: 'no_fuel', message };
  }

  // The thinking side has its own daily allowance, so an afternoon in here can
  // never turn tomorrow morning's brief mechanical (llm/budget.ts).
  const budget = await checkThinkingBudget(db, orgId, now());
  if (budget.over) {
    const message = `This account has reached its daily limit for chat ($${budget.capUsd.toFixed(2)}). It resets tomorrow — the watching and your morning brief are unaffected.`;
    await say(db, orgId, thread, message);
    return { ok: false, reason: 'over_budget', message };
  }

  const history = await db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(MAX_HISTORY);

  const conversation = history
    .reverse()
    .filter((m) => m.role === 'owner' || m.role === 'agent')
    .map((m) => `${m.role === 'owner' ? 'Owner' : 'Selvedge'}: ${clip(m.content, MAX_MESSAGE_CHARS)}`)
    .join('\n\n');

  // A thread under a SUBJECT is about no project, so there is no project
  // context to give — and the system prompt's "say what you can't see" rule
  // covers the difference honestly.
  const project = thread.projectId ? await projectContext(db, orgId, thread.projectId) : null;
  const model = chatModel(provider);
  const result = await deps.client.complete({
    model,
    system: SYSTEM,
    userContent: [
      project ? `The project this conversation is about:\n${JSON.stringify(project, null, 2)}` : 'I have no context pack for this project, so I know nothing about it beyond this conversation.',
      '',
      `The conversation so far (the last message is what you are answering):\n\n${conversation}`,
    ].join('\n'),
    maxTokens: MAX_REPLY_TOKENS,
    schema: CHAT_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(db, orgId, 'chat', result, undefined, thread.id);

  if (!result.ok) {
    const message = "I couldn't get an answer just then. Nothing was lost — ask me again.";
    await say(db, orgId, thread, message);
    return { ok: false, reason: 'model_failed', message };
  }

  const reply = (result.json as { reply?: unknown }).reply;
  if (typeof reply !== 'string' || reply.trim() === '') {
    const message = "I couldn't get an answer just then. Nothing was lost — ask me again.";
    await say(db, orgId, thread, message);
    return { ok: false, reason: 'model_failed', message };
  }

  await say(db, orgId, thread, reply.trim());
  return { ok: true, reply: reply.trim(), model, costed: true };
}
