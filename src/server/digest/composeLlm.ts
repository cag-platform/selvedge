import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { LlmClient } from '../llm/types.js';
import { composeModel } from '../llm/config.js';
import { recordUsage } from '../llm/metering.js';
import { checkDailyBudget } from '../llm/budget.js';
import { isVerdict } from '../narration/verdictText.js';
import type { Verdict } from '../narration/types.js';
import type { DigestSections } from './render.js';
import type { OpenThread } from './render.js';
import { validateComposedBrief, type ComposerInputSummary } from './validator.js';

const PROMPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/prompts/composer-system.md');

let cachedPrompt: string | null = null;

function promptTemplate(): string {
  if (!cachedPrompt) {
    cachedPrompt = readFileSync(PROMPT_PATH, 'utf-8').replace(/^<!--[\s\S]*?-->\s*/, '');
  }
  return cachedPrompt;
}

export function resetComposerPromptCache(): void {
  cachedPrompt = null;
}

const COMPOSE_SCHEMA = {
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
  additionalProperties: false,
} as const;

/** Composer doc §1 rule 8: ~180–260 words for an 8-project stack on a normal day. Scales down for smaller stacks. */
export function wordBudgetFor(projectCount: number): number {
  return Math.max(100, Math.min(260, 120 + 18 * projectCount));
}

export type ComposeLlmDeps = { llm: LlmClient; db: Db };

export type ComposedResult =
  | { ok: true; brief: string; recomposed: boolean }
  | { ok: false; reason: string; violations?: string[] };

/**
 * Stage 2 (Phase 2 deliverable 6): one composition call per org per day.
 * Pre-composition logic (compose.ts) already selected and annotated the
 * fragments — the model composes, code decides what it sees. Output runs
 * the post-composition validator; a violation triggers exactly one
 * recomposition with the violation named; a second failure returns not-ok
 * and the caller falls back to the mechanical digest. The brief always sends.
 */
export async function composeBriefLlm(
  deps: ComposeLlmDeps,
  orgId: string,
  sections: DigestSections,
  previousOpenThreads: OpenThread[],
  packMeta: Array<{ project_id: string; name: string; tier: string; detail_level: string; language: string }>,
): Promise<ComposedResult> {
  const fragments = [
    ...sections.attention.map((n) => ({
      project: n.pack?.identity.name ?? 'Selvedge',
      kind: 'attention' as const,
      fragment: n.fragment ?? '',
      ...(n.verdict ? { verdict: n.verdict } : {}),
    })),
    ...sections.moved.map((n) => ({
      project: n.pack?.identity.name ?? 'Selvedge',
      kind: 'moved' as const,
      fragment: n.fragment ?? '',
      ...(n.verdict ? { verdict: n.verdict } : {}),
    })),
  ];

  // Org-level register: the digest is one note but detail_level is per-pack.
  // Use the most common level across packs (tie -> plain_expandable). Flagged
  // in the PR description — an org-level voice setting is the cleaner fix.
  const levelCounts = new Map<string, number>();
  for (const p of packMeta) levelCounts.set(p.detail_level, (levelCounts.get(p.detail_level) ?? 0) + 1);
  const detailLevel =
    [...levelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'plain_expandable';
  const language = packMeta[0]?.language ?? 'en';
  const wordBudget = wordBudgetFor(packMeta.length);

  const system = promptTemplate()
    .replaceAll('{word_budget}', String(wordBudget))
    .replaceAll('{detail_level}', detailLevel)
    .replaceAll('{language}', language);

  const composerInput = {
    fragments,
    closed_threads: sections.closedThreads,
    open_threads_from_yesterday: previousOpenThreads.map((t) => ({ project_id: t.project_id, summary: t.summary })),
    standing: sections.standing,
    quiet: sections.quiet,
    storm: sections.storm,
    ...(sections.storm ? { attention_items_not_shown: sections.attentionTotal - sections.attention.length } : {}),
    projects: packMeta.map((p) => ({ project_id: p.project_id, name: p.name, tier: p.tier })),
  };

  const verdicts = fragments.map((f) => ('verdict' in f ? f.verdict : undefined)).filter(isVerdict) as Verdict[];
  const inputText = JSON.stringify(composerInput).toLowerCase();
  const inputSummary: ComposerInputSummary = {
    verdicts,
    inputProjectNames: packMeta.filter((p) => inputText.includes(p.name.toLowerCase())).map((p) => p.name),
    allKnownProjectNames: packMeta.map((p) => p.name),
    attentionCount: sections.attention.length,
    wordBudget,
  };

  let userContent = JSON.stringify(composerInput, null, 2);

  // The daily spend cap, enforced on the composition call too. Over budget
  // returns a normal failure, which the caller already handles by sending the
  // mechanical brief — the brief always sends.
  const budget = await checkDailyBudget(deps.db, orgId);
  if (budget.over) return { ok: false, reason: 'daily_budget_exceeded' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await deps.llm.complete({
      model: composeModel(),
      system,
      userContent,
      maxTokens: 2048,
      schema: COMPOSE_SCHEMA as unknown as Record<string, unknown>,
    });
    await recordUsage(deps.db, orgId, 'compose', result);

    if (!result.ok) return { ok: false, reason: result.reason };

    const brief = (result.json as { brief?: unknown }).brief;
    if (typeof brief !== 'string' || brief.trim().length === 0) {
      return { ok: false, reason: 'empty_brief' };
    }

    const validation = validateComposedBrief(brief, inputSummary);
    if (validation.ok) return { ok: true, brief: brief.trim(), recomposed: attempt === 1 };

    if (attempt === 0) {
      // One recomposition, with the violation named (brief, deliverable 6).
      userContent = `${JSON.stringify(composerInput, null, 2)}\n\nYour previous composition failed validation:\n- ${validation.violations.join('\n- ')}\nRecompose the brief fixing every violation. Do not drop any verdict phrase.`;
      continue;
    }
    return { ok: false, reason: 'validator_failed_twice', violations: validation.violations };
  }

  return { ok: false, reason: 'unreachable' };
}
