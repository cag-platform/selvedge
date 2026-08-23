import type { FuelProvider } from '../connectors/registry.js';
import type { LlmClient } from '../llm/types.js';
import { chatModel } from '../llm/config.js';

/**
 * EXTRACTING WHAT WAS DECIDED from a conversation that was mostly deciding.
 *
 * A thinking thread is long, circular, and full of ideas that were tried and
 * dropped. Handing all of it to a builder produces the average of everything
 * ever said in it. So a short statement is extracted — and then handed to a
 * person to correct, because the model's reading of a conversation is a draft
 * and the owner's is the record.
 *
 * The two rules in the prompt are the ones that make the output safe to build
 * from: take only what was actually settled, and say what wasn't. A brief that
 * quietly resolves an open question is worse than no brief, because the builder
 * will act on it.
 */

export type DecisionDraft = {
  title: string;
  decision: string;
  why: string | null;
  constraints: string[];
  openQuestions: string[];
};

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    decision: { type: 'string' },
    why: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'decision', 'why', 'constraints', 'open_questions'],
  additionalProperties: false,
} as const;

const SYSTEM = `You read a conversation between a software owner and an assistant, and write down what was DECIDED in it.

You are writing the note a builder will work from, so:
- "decision" is what to build, in the owner's own words, in a few plain sentences. Not a plan, not a spec — the decision.
- "why" is the reason it was chosen, when the conversation gives one. If it doesn't, say so plainly rather than inventing a rationale.
- "constraints" are the things this must not break, only when the conversation actually named them.
- "open_questions" are the things that were raised and NOT settled. Never resolve one yourself: a brief that quietly answers an open question is worse than no brief, because the builder will act on it.
- "title" is four or five words a person would recognise the decision by.

Take nothing from outside the conversation. If the conversation did not decide anything, say exactly that in "decision" and leave the rest empty.`;

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 1200;

export type ExtractInput = { role: string; content: string }[];

/** The conversation, bounded, in the shape the model reads. */
export function transcriptFor(messages: ExtractInput): string {
  return messages
    .filter((m) => m.role === 'owner' || m.role === 'agent')
    .slice(-MAX_MESSAGES)
    .map((m) => `${m.role === 'owner' ? 'Owner' : 'Selvedge'}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n\n');
}

function strings(value: unknown, max = 8): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim().slice(0, 300)).slice(0, max)
    : [];
}

/** Read the model's answer into a draft, or nothing. Never throws on a shape it didn't expect. */
export function parseDecision(json: unknown): DecisionDraft | null {
  const body = json as Record<string, unknown> | null;
  const decision = typeof body?.decision === 'string' ? body.decision.trim() : '';
  if (!body || decision === '') return null;
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'A decision';
  const why = typeof body.why === 'string' && body.why.trim() ? body.why.trim().slice(0, 1000) : null;
  return {
    title,
    decision: decision.slice(0, 4000),
    why,
    constraints: strings(body.constraints),
    openQuestions: strings(body.open_questions),
  };
}

export type ExtractResult = { ok: true; draft: DecisionDraft } | { ok: false; reason: string };

export async function extractDecision(client: LlmClient, provider: FuelProvider, messages: ExtractInput): Promise<ExtractResult> {
  const transcript = transcriptFor(messages);
  if (transcript.trim() === '') return { ok: false, reason: 'there is nothing in this conversation to extract a decision from' };

  const result = await client.complete({
    model: chatModel(provider),
    system: SYSTEM,
    userContent: `The conversation:\n\n${transcript}`,
    maxTokens: 900,
    schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
  });
  if (!result.ok) return { ok: false, reason: "I couldn't read that conversation just now — try again" };
  const draft = parseDecision(result.json);
  return draft ? { ok: true, draft } : { ok: false, reason: "I couldn't find a decision in that conversation" };
}
