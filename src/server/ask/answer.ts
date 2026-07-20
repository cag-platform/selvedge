import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import { edgeStatus, healthLine } from '../packs/healthLine.js';
import type { LlmClient } from '../llm/types.js';
import { composeModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';

export type AskDeps = { llm: LlmClient; db: Db };

export type AskResult = { ok: true; answer: string } | { ok: false; reason: string };

const ASK_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

// The same voice as the composer, pointed at a free-text question. Structured
// output (one `answer` string) keeps it on the existing LLM seam. The
// context-only / no-fabrication / verdict-honesty rules are the composer's
// §1 and §7 rules restated — the false calm is unforgivable here too.
const SYSTEM = `You answer a solo builder's questions about their own software projects.
You are calm, specific, and honest — never a dashboard, a marketer, or an alarm.

You are given a snapshot of the builder's stack (their projects, each project's
plain status, and today's brief if one exists). Answer ONLY from that snapshot.
Rules:
- Use the owner's own names and words for their projects.
- Never invent events, numbers, statuses, or causes not present in the snapshot.
- If the snapshot doesn't contain the answer, say so plainly — "I can't see that
  from here" — and, if useful, say what you can see. Never guess that something
  is fine. A confidently-wrong "all clear" is the one unforgivable answer.
- Lead with the verdict when the question is about whether something is okay.
- Keep it short and plain. No infrastructure jargon unless the builder used it.
- Answer in the language the question is asked in.`;

/**
 * Free-text Ask over the whole stack. Gathers the org's packs (name, tier,
 * plain status, health line, gaps) and the most recent brief as context, then
 * asks the model to answer the question against it. Every call is metered like
 * any other model call.
 */
export async function answerQuestion(deps: AskDeps, orgId: string, question: string): Promise<AskResult> {
  const packs = await listPacks(deps.db, orgId);
  const projects = packs.map((p) => ({
    name: p.identity.name,
    tier: p.stakes.tier,
    what_it_is: p.identity.owner_description,
    status: edgeStatus(p),
    plain_status: healthLine(p),
    ...(p.topology.capability_gaps?.length ? { gaps: p.topology.capability_gaps.map((g) => g.summary) } : {}),
    ...(p.state?.stalled?.length ? { stalled: p.state.stalled.map((s) => s.summary ?? s.ref) } : {}),
  }));

  const [latest] = await deps.db
    .select()
    .from(digests)
    .where(eq(digests.orgId, orgId))
    .orderBy(desc(digests.digestDate))
    .limit(1);

  const context = {
    projects,
    todays_brief: latest
      ? { date: latest.digestDate, headline: latest.headline, note: latest.renderedText }
      : null,
  };

  const userContent = `Question: ${question}\n\nWhat I know about your stack:\n${JSON.stringify(context, null, 2)}`;

  const result = await deps.llm.complete({
    model: composeModel(),
    system: SYSTEM,
    userContent,
    maxTokens: 700,
    schema: ASK_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(deps.db, orgId, 'gist', result);

  if (!result.ok) return { ok: false, reason: result.reason };
  const answer = (result.json as { answer?: unknown }).answer;
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    return { ok: false, reason: 'empty_answer' };
  }
  return { ok: true, answer: answer.trim() };
}
