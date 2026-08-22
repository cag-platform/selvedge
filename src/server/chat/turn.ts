import { ulid } from 'ulid';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { healthLine } from '../packs/healthLine.js';
import { renderReferences, resolveReferences } from '../references/resolve.js';
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

const SYSTEM_BASE = `You are Selvedge, talking with the owner of a small software project.

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

/**
 * WHO IS SPEAKING, when the owner named somebody.
 *
 * "@claude and @gpt, what do you think?" asks two named models for their own
 * takes. Handed the plain prompt, each was told it was Selvedge — so the one
 * running on Anthropic's model opened with "I'm not Claude or GPT, just me
 * here", which is both false and exactly the opposite of what was asked for.
 *
 * The correction is the truth: this IS that model (providerForTake routes the
 * call to it), answering inside Selvedge because somebody asked it to. So it
 * is told so, and told that the other agents in the room are answering the
 * same question — which is the whole reason to ask more than one.
 */
function systemFor(speaking: AgentId, asTake: boolean): string {
  if (!asTake) return SYSTEM_BASE;
  const name = agentById(speaking)?.name ?? speaking;
  return `${SYSTEM_BASE}

The owner asked for YOUR take by name, so answer as ${name} — that is the model
this conversation is being run on, and saying you are something else, or that
you are "not ${name}", would simply be untrue. Others may have been asked the
same question alongside you; answer with your own view rather than trying to
agree with theirs, and don't introduce yourself — the conversation already shows
who said what.`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

export type ChatDeps = {
  client?: LlmClient | null;
  now?: () => Date;
  /** False when the caller has already written the owner's message. */
  recordOwnerMessage?: boolean;
  /** Answer as this agent rather than the thread's own. */
  answeringAs?: AgentId;
  /** The line the conversation shows about what this turn read from elsewhere. */
  referenceNote?: string;
  /**
   * A take, not a turn: the agent has been asked what it thinks, and is
   * answering over its model without the sandbox. This is the only way a
   * builder speaks on this path, and the conversation says so out loud.
   */
  asTake?: boolean;
};

/**
 * The provider this agent answers on, or null when it answers by editing files
 * instead — a builder's turn goes through the sandbox, not this path.
 */
export function chatProviderFor(agent: AgentId): 'anthropic' | 'openai' | null {
  const descriptor = agentById(agent);
  if (!descriptor || descriptor.changesFiles) return null;
  return descriptor.provider;
}

/**
 * The provider to answer on, allowing for a take.
 *
 * A builder asked for its opinion answers on the model behind it, with no
 * sandbox attached — which is a real thing to offer and a slightly different
 * thing from that builder doing the work, so the consultation line says as
 * much rather than letting the distinction pass unremarked.
 */
function providerForTake(agent: AgentId, asTake: boolean): 'anthropic' | 'openai' | null {
  if (!asTake) return chatProviderFor(agent);
  return agentById(agent)?.provider ?? null;
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

/**
 * Every answer records who gave it. Without this a consultation is two
 * paragraphs from nobody in particular, and the whole point of asking two
 * agents is knowing which one said which.
 */
async function say(db: Db, orgId: string, thread: Thread, content: string, answeredBy: AgentId): Promise<void> {
  await db.insert(agentMessages).values({
    id: ulid(),
    orgId,
    projectId: thread.projectId,
    threadId: thread.id,
    role: 'agent',
    content,
    meta: { answered_by: answeredBy },
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
  deps: ChatDeps = {},
): Promise<ChatOutcome> {
  const now = deps.now ?? (() => new Date());
  // In a consultation the question is asked once and answered several times,
  // so the caller writes the owner's message itself and every answer hangs off
  // that one line rather than each turn re-asking it.
  if (deps.recordOwnerMessage !== false) {
    await db.insert(agentMessages).values({
      id: ulid(),
      orgId,
      projectId: thread.projectId,
      threadId: thread.id,
      role: 'owner',
      content: ownerText,
    });
    // Directly beneath the ask that pulled it in — written here rather than by
    // the caller so it can never land above the message it belongs to.
    if (deps.referenceNote) {
      await db
        .insert(agentMessages)
        .values({ id: ulid(), orgId, projectId: thread.projectId, threadId: thread.id, role: 'switch', content: deps.referenceNote })
        .catch(() => undefined);
    }
  }

  // Who is answering is not always the thread's own agent: a consultation asks
  // several, and none of them takes the conversation over.
  const speaking = (deps.answeringAs ?? thread.agent) as AgentId;
  const provider = providerForTake(speaking, deps.asTake === true);
  if (!provider || !deps.client) {
    const name = agentById(speaking)?.name ?? speaking;
    const message = `This thread runs on ${name}, and there's no key connected for it — so I can't answer here yet. Connect one under Connections, or switch this thread to a model you have connected.`;
    await say(db, orgId, thread, message, speaking);
    return { ok: false, reason: 'no_fuel', message };
  }

  // The thinking side has its own daily allowance, so an afternoon in here can
  // never turn tomorrow morning's brief mechanical (llm/budget.ts).
  const budget = await checkThinkingBudget(db, orgId, now());
  if (budget.over) {
    const message = `This account has reached its daily limit for chat ($${budget.capUsd.toFixed(2)}). It resets tomorrow — the watching and your morning brief are unaffected.`;
    await say(db, orgId, thread, message, speaking);
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
  // WHAT THEY POINTED AT. A conversation about one project routinely needs
  // another — "does this match how #loom does it" — and until now the answer
  // was whatever the model could guess. Resolved from the stored text, bounded,
  // and carrying the mark on anything that was said somewhere else.
  const referenced = renderReferences(await resolveReferences(db, orgId, ownerText).catch(() => ({ resolved: [], missed: [] })));
  const model = chatModel(provider);
  const result = await deps.client.complete({
    model,
    system: systemFor(speaking, deps.asTake === true),
    userContent: [
      project ? `The project this conversation is about:\n${JSON.stringify(project, null, 2)}` : 'I have no context pack for this project, so I know nothing about it beyond this conversation.',
      '',
      ...(referenced ? [referenced, ''] : []),
      `The conversation so far (the last message is what you are answering):\n\n${conversation}`,
    ].join('\n'),
    maxTokens: MAX_REPLY_TOKENS,
    schema: CHAT_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(db, orgId, 'chat', result, undefined, thread.id);

  if (!result.ok) {
    const message = "I couldn't get an answer just then. Nothing was lost — ask me again.";
    await say(db, orgId, thread, message, speaking);
    return { ok: false, reason: 'model_failed', message };
  }

  const reply = (result.json as { reply?: unknown }).reply;
  if (typeof reply !== 'string' || reply.trim() === '') {
    const message = "I couldn't get an answer just then. Nothing was lost — ask me again.";
    await say(db, orgId, thread, message, speaking);
    return { ok: false, reason: 'model_failed', message };
  }

  await say(db, orgId, thread, reply.trim(), speaking);
  return { ok: true, reply: reply.trim(), model, costed: true };
}
