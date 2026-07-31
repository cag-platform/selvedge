import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import { edgeStatus, healthLine } from '../packs/healthLine.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { LlmClient } from '../llm/types.js';
import { composeModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';

export type AskDeps = { llm: LlmClient; db: Db };

export type AskResult = { ok: true; answer: string } | { ok: false; reason: string };

// Context bounds: the model input must not scale unboundedly with the size of
// a stack. A big org (many packs, long descriptions, the whole latest brief)
// would otherwise blow the token budget on a single Ask. We show the most
// important projects, truncate free text, and say plainly what we left out.
const MAX_PROJECTS = 40;
const MAX_FIELD_CHARS = 240;
const MAX_NOTE_CHARS = 4000;
const TIER_RANK: Record<string, number> = { live_critical: 3, live_small: 2, personal: 1, sandbox: 0 };

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Most-recent event timestamp across a pack's sources, for recency ranking. */
function recencyKey(pack: ContextPack): number {
  let max = 0;
  for (const iso of Object.values(pack.state?.last_event_at_by_source ?? {})) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > max) max = ms;
  }
  return max;
}

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
  const allPacks = await listPacks(deps.db, orgId);
  // Highest-stakes first, then most-recently-active, then name for stability.
  const ranked = [...allPacks].sort(
    (a, b) =>
      (TIER_RANK[b.stakes.tier] ?? 0) - (TIER_RANK[a.stakes.tier] ?? 0) ||
      recencyKey(b) - recencyKey(a) ||
      a.identity.name.localeCompare(b.identity.name),
  );
  const shown = ranked.slice(0, MAX_PROJECTS);
  const omitted = ranked.length - shown.length;

  const projects = shown.map((p) => ({
    name: p.identity.name,
    tier: p.stakes.tier,
    what_it_is: truncate(p.identity.owner_description, MAX_FIELD_CHARS),
    status: edgeStatus(p),
    plain_status: healthLine(p),
    ...(p.topology.capability_gaps?.length
      ? { gaps: p.topology.capability_gaps.slice(0, 5).map((g) => truncate(g.summary, MAX_FIELD_CHARS)) }
      : {}),
    ...(p.state?.stalled?.length
      ? { stalled: p.state.stalled.slice(0, 5).map((s) => truncate(s.summary ?? s.ref, MAX_FIELD_CHARS)) }
      : {}),
  }));

  const [latest] = await deps.db
    .select()
    .from(digests)
    .where(eq(digests.orgId, orgId))
    .orderBy(desc(digests.digestDate))
    .limit(1);

  const context = {
    projects,
    ...(omitted > 0 ? { projects_not_shown: `${omitted} lower-stakes project${omitted === 1 ? '' : 's'} omitted to stay concise` } : {}),
    todays_brief: latest
      ? { date: latest.digestDate, headline: latest.headline, note: truncate(latest.renderedText, MAX_NOTE_CHARS) }
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
