import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { LlmClient } from '../llm/types.js';
import { narrateModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';
import { packToNarratorContext } from './packContext.js';
import { VERDICT_PHRASE, isVerdict } from './verdictText.js';
import type { NarratableEvent, NarrationOutput } from './types.js';

const PROMPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/prompts/fragment-system.md');

let cachedPrompt: string | null = null;

function promptTemplate(): string {
  if (!cachedPrompt) {
    // The HTML comment header is version metadata for humans/diffs, not model input.
    cachedPrompt = readFileSync(PROMPT_PATH, 'utf-8').replace(/^<!--[\s\S]*?-->\s*/, '');
  }
  return cachedPrompt;
}

/** Test hook: prompt edits during a process's lifetime (evals) re-read the file. */
export function resetFragmentPromptCache(): void {
  cachedPrompt = null;
}

export const FRAGMENT_SCHEMA = {
  type: 'object',
  properties: {
    fragment: { type: 'string' },
    verdict: { type: 'string', enum: ['users_affected', 'users_fine', 'cannot_tell'] },
    checking: { type: 'string' },
    technical_line: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['fragment', 'technical_line', 'confidence'],
  additionalProperties: false,
} as const;

export type FragmentCallResult =
  | { ok: true; output: NarrationOutput; confidence: string }
  | { ok: false; reason: string };

/**
 * One fragment call: system (versioned voice rules) + context (the pack's
 * narrator slice) + event (+ any collapse-window siblings). Returns a
 * failure — never throws — so the dispatcher can fall back to the Phase 1
 * template; the digest must never fail to send because a model call failed.
 */
export async function llmFragmentCall(
  deps: { llm: LlmClient; db: Db },
  orgId: string,
  event: NarratableEvent,
  pack: ContextPack,
  requireVerdict: boolean,
  collapseSiblings: Array<{ event_type: string; occurred_at: string }> = [],
): Promise<FragmentCallResult> {
  const context = packToNarratorContext(pack);
  const system = promptTemplate()
    .replaceAll('{language}', context.language)
    .replaceAll('{detail_level}', context.detail_level);

  const userContent = JSON.stringify(
    {
      project_context: context,
      event: {
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        severity_hint: event.severity_hint,
      },
      ...(collapseSiblings.length > 0 ? { sibling_events_in_collapse_window: collapseSiblings } : {}),
      ...(requireVerdict ? { verdict_required: true } : {}),
    },
    null,
    2,
  );

  const result = await deps.llm.complete({
    model: narrateModel(),
    system,
    userContent,
    maxTokens: 1024,
    schema: FRAGMENT_SCHEMA as unknown as Record<string, unknown>,
  });
  await recordUsage(deps.db, orgId, 'fragment', result, event.id);

  if (!result.ok) return { ok: false, reason: result.reason };

  const json = result.json as {
    fragment?: unknown;
    verdict?: unknown;
    checking?: unknown;
    technical_line?: unknown;
    confidence?: unknown;
  };

  if (typeof json.fragment !== 'string' || json.fragment.trim().length === 0) {
    return { ok: false, reason: 'empty_fragment' };
  }

  const verdict = isVerdict(json.verdict) ? json.verdict : undefined;
  // An LLM+VERDICT row's response without a verdict is a failed call (brief).
  if (requireVerdict && !verdict) return { ok: false, reason: 'missing_verdict' };
  // cannot_tell must include what's being checked (brief) — without it,
  // "can't tell yet" degrades into unexplained vagueness.
  if (verdict === 'cannot_tell' && (typeof json.checking !== 'string' || json.checking.trim().length === 0)) {
    return { ok: false, reason: 'cannot_tell_without_checking' };
  }

  let fragment = json.fragment.trim();
  if (verdict && !fragment.toLowerCase().includes(VERDICT_PHRASE[verdict])) {
    // The canonical phrase is what the validator/evals check by containment.
    // Appending it (rather than failing the call) keeps verdict rendering
    // deterministic without burning the fragment.
    fragment = `${fragment} ${verdict === 'cannot_tell' ? `I ${VERDICT_PHRASE.cannot_tell} — checking ${(json.checking as string).trim()}.` : `In short: ${VERDICT_PHRASE[verdict]}.`}`;
  }

  const output: NarrationOutput = {
    fragment,
    ...(typeof json.technical_line === 'string' && json.technical_line ? { technicalDetail: json.technical_line } : {}),
    ...(verdict ? { verdict } : {}),
  };
  return { ok: true, output, confidence: typeof json.confidence === 'string' ? json.confidence : 'medium' };
}
