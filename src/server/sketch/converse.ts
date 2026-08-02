import type { Db } from '../db/client.js';
import type { LlmClient } from '../llm/types.js';
import { sketchModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';
import { checkSketchBudget } from '../llm/budget.js';
import { getPack, listPacks } from '../packs/store.js';
import { edgeStatus, healthLine } from '../packs/healthLine.js';
import { projectMemory } from '../memory/learned.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { SketchMessageRow } from './store.js';

/**
 * The thinking half of Sketch: one turn of conversation about an idea, with
 * the project's story as context and no sandbox anywhere near it.
 *
 * The LLM seam (llm/types.ts) is single-string and structured-output-only —
 * there is no messages array and no streaming. So the transcript is flattened
 * into userContent, which keeps fuel resolution, metering and the budget gate
 * working unchanged. The structured reply is what makes "the idea is ready"
 * reliable data instead of prose somebody has to parse.
 */

export type SketchDeps = { llm: LlmClient; db: Db };

export type SketchReply = {
  reply: string;
  questions: string[];
  ready: boolean;
  brief: string | null;
};

export type SketchTurnResult =
  | { ok: true; reply: SketchReply }
  | { ok: false; reason: 'over_budget'; spentUsd: number; capUsd: number }
  | { ok: false; reason: 'model_failed'; detail: string };

// Context bounds, same discipline as ask/answer.ts: the model input must not
// grow without limit as a conversation gets long. We keep the most recent
// turns, truncate each, and say plainly when earlier ones were dropped.
const MAX_TURNS = 20;
const MAX_MESSAGE_CHARS = 2000;
const MAX_FIELD_CHARS = 240;
const MAX_PROJECTS = 25;
const TIER_RANK: Record<string, number> = { live_critical: 3, live_small: 2, personal: 1, sandbox: 0 };

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

const SKETCH_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    ready: { type: 'boolean' },
    brief: { type: ['string', 'null'] },
  },
  required: ['reply', 'questions', 'ready', 'brief'],
  additionalProperties: false,
} as const;

/**
 * A thinking partner, not a yes-man. The failure mode this prompt exists to
 * prevent is enthusiastic agreement with a half-formed idea — that is exactly
 * what sends someone into the workshop to spend real money building the wrong
 * thing, which is the cost Sketch exists to avoid.
 */
const SYSTEM = `You help a solo builder think through an idea for their own software, BEFORE any code is written.
You are a thoughtful partner: curious, direct, and honest. You are not a cheerleader.

You are given what is known about their project — what it is, who uses it, how it has been behaving — and the
conversation so far.

How to behave:
- Ask at most ONE or TWO questions per reply, and only ones whose answer would genuinely change what gets built.
  Never interrogate. If a detail is minor, state the assumption you would make and move on.
- Push back when an idea is vague, bigger than it sounds, or likely to cause trouble for the people who use the
  app. Say so plainly and say why. Naming a problem early is the whole value here.
- Prefer the smallest version worth building. If the idea is really three things, say which one to do first.
- Talk in the owner's own words for their app and its parts. No jargon unless they used it. Never mention files,
  frameworks, or code structure — you have not seen the code.
- Never invent facts about their app that are not in the context you were given. If you would need to look at the
  code to answer well, say so plainly; there is a separate way to do that.

The three fields besides "reply":
- "questions": what is still genuinely unsettled. Empty when nothing is.
- "ready": true only when you could hand this to a builder and they would know what to make, with no important
  question left open. Do not set it true just because the conversation has gone on a while.
- "brief": when ready is true, the instruction to hand to the builder — plain English, specific about what should
  exist and how it should behave when done. Include anything settled during the conversation. Otherwise null.

Answer in the language the builder is writing in.`;

function packContext(pack: ContextPack) {
  return {
    name: pack.identity.name,
    what_it_is: truncate(pack.identity.owner_description, MAX_FIELD_CHARS),
    ...(pack.identity.audience ? { who_uses_it: truncate(pack.identity.audience, MAX_FIELD_CHARS) } : {}),
    stakes: pack.stakes.tier,
    real_people_use_it: pack.stakes.has_external_users,
    money_moves_through_it: pack.stakes.touches_money,
    ...(pack.stakes.downtime_translation ? { if_it_breaks: truncate(pack.stakes.downtime_translation, MAX_FIELD_CHARS) } : {}),
    ...(pack.topology.stack_summary ? { built_with: truncate(pack.topology.stack_summary, MAX_FIELD_CHARS) } : {}),
    status: edgeStatus(pack),
    plain_status: healthLine(pack),
    ...(pack.topology.capability_gaps?.length
      ? { known_gaps: pack.topology.capability_gaps.slice(0, 5).map((g) => truncate(g.summary, MAX_FIELD_CHARS)) }
      : {}),
  };
}

/** How the owner wants to be spoken to — honoured here, unlike Ask, because this is a conversation. */
function voiceNote(pack: ContextPack | null): string {
  if (!pack) return '';
  const bits: string[] = [];
  if (pack.voice?.language) bits.push(`Write in ${pack.voice.language}.`);
  if (pack.voice?.detail_level === 'plain_only') bits.push('Keep it plain — no technical detail at all.');
  if (pack.voice?.detail_level === 'technical_forward') bits.push('This owner is comfortable with technical detail.');
  for (const g of pack.voice?.glossary_overrides ?? []) {
    bits.push(`Say "${g.preferred_phrasing}" rather than "${g.term}".`);
  }
  return bits.length ? `\n\nHow this owner likes to be spoken to:\n${bits.join('\n')}` : '';
}

/**
 * One turn. `history` is the conversation so far (oldest first), `text` is what
 * the owner just said — already persisted by the caller, so it is passed
 * separately rather than being expected at the tail of history.
 */
export async function sketchTurn(
  deps: SketchDeps,
  orgId: string,
  projectId: string | null,
  history: SketchMessageRow[],
  text: string,
): Promise<SketchTurnResult> {
  // The gate, before spending anything. Ask never checks its budget; this does.
  const budget = await checkSketchBudget(deps.db, orgId);
  if (budget.over) {
    return { ok: false, reason: 'over_budget', spentUsd: budget.spentUsd, capUsd: budget.capUsd };
  }

  const pack = projectId ? await getPack(deps.db, orgId, projectId) : null;

  let about: unknown;
  if (pack) {
    const memory = await projectMemory(deps.db, orgId, pack.identity.project_id).catch(() => null);
    about = {
      project: packContext(pack),
      ...(memory?.learned_signatures?.length
        ? {
            what_selvedge_has_learned: memory.learned_signatures
              .slice(0, 8)
              .map((s) => `${s.plain} (seen ${s.times_seen}×${s.possibly_stale ? ', might be out of date' : ''})`),
          }
        : {}),
    };
  } else {
    // No project attached yet — give the stack in outline so the model can ask
    // which app this is about, rather than guessing.
    const ranked = [...(await listPacks(deps.db, orgId))].sort(
      (a, b) => (TIER_RANK[b.stakes.tier] ?? 0) - (TIER_RANK[a.stakes.tier] ?? 0) || a.identity.name.localeCompare(b.identity.name),
    );
    about = {
      no_project_chosen_yet: true,
      their_projects: ranked.slice(0, MAX_PROJECTS).map((p) => ({
        name: p.identity.name,
        what_it_is: truncate(p.identity.owner_description, MAX_FIELD_CHARS),
        stakes: p.stakes.tier,
      })),
    };
  }

  const kept = history.slice(-MAX_TURNS);
  const dropped = history.length - kept.length;
  const transcript = kept
    .map((m) => `${m.role === 'owner' ? 'BUILDER' : 'YOU'}: ${truncate(m.content, MAX_MESSAGE_CHARS)}`)
    .join('\n\n');

  const userContent = [
    `What I know about their work:\n${JSON.stringify(about, null, 2)}`,
    dropped > 0 ? `\n(${dropped} earlier message${dropped === 1 ? '' : 's'} in this conversation are not shown.)` : '',
    transcript ? `\n\nThe conversation so far:\n${transcript}` : '',
    `\n\nBUILDER just said:\n${truncate(text, MAX_MESSAGE_CHARS)}`,
    voiceNote(pack),
  ].join('');

  const result = await deps.llm.complete({
    model: sketchModel(),
    system: SYSTEM,
    userContent,
    maxTokens: 1200,
    schema: SKETCH_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(deps.db, orgId, 'sketch', result);

  if (!result.ok) return { ok: false, reason: 'model_failed', detail: result.reason };

  const json = result.json as Partial<SketchReply>;
  const replyText = typeof json.reply === 'string' ? json.reply.trim() : '';
  if (replyText === '') return { ok: false, reason: 'model_failed', detail: 'empty_reply' };

  const brief = typeof json.brief === 'string' && json.brief.trim() !== '' ? json.brief.trim() : null;
  // Guard the contract rather than trusting it: "ready" without an actual
  // brief would light up a Build button with nothing behind it.
  const ready = json.ready === true && brief !== null;

  return {
    ok: true,
    reply: {
      reply: replyText,
      questions: Array.isArray(json.questions) ? json.questions.filter((q): q is string => typeof q === 'string' && q.trim() !== '') : [],
      ready,
      brief: ready ? brief : null,
    },
  };
}
