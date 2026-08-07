import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from '../db/client.js';
import type { LlmClient } from '../llm/types.js';
import { recordUsage } from '../llm/metering.js';
import { checkGradeBudget } from '../llm/budget.js';
import type { JudgeAnswer } from './checks.js';

const PROMPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/prompts/grader-system.md');

let cachedPrompt: string | null = null;

function promptTemplate(): string {
  if (!cachedPrompt) {
    // The HTML comment header is version metadata for humans/diffs, not model input.
    cachedPrompt = readFileSync(PROMPT_PATH, 'utf-8').replace(/^<!--[\s\S]*?-->\s*/, '');
  }
  return cachedPrompt;
}

/** Test hook: prompt edits during a process's lifetime (evals) re-read the file. */
export function resetGraderPromptCache(): void {
  cachedPrompt = null;
}

/**
 * Strict-compatible by design: closed object, every property required — so the
 * OpenAI adapter's `strictable()` engages strict mode and the response is
 * schema-guaranteed rather than best-effort. (FRAGMENT_SCHEMA deliberately
 * isn't, which is why that check exists at all.)
 */
export const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['pass', 'fail', 'cannot_tell'] },
    reason: { type: 'string' },
  },
  required: ['outcome', 'reason'],
  additionalProperties: false,
} as const;

const MAX_TOKENS = 500;

export type GraderDeps = { llm: LlmClient; db: Db; model: string };

/**
 * One grade: did the change do what was asked? The judge implementation behind
 * RunCheckDeps.judge — a model on a DIFFERENT provider than authored the
 * change, reading the ask and the diff.
 *
 * Every path that isn't a clean, schema-valid answer is `cannot_tell`: over
 * budget, model unreachable, refusal, malformed output. A grader that cannot
 * grade must never default to an opinion — `cannot_tell` runs as
 * could_not_run, and the verdict caps at `probably`, which is exactly what the
 * card would have gotten with no grader at all. The failure mode of this
 * function is the absence of a claim, never a wrong one.
 */
export async function gradeAcceptance(
  deps: GraderDeps,
  orgId: string,
  spec: { ask: string; evidence: string },
): Promise<JudgeAnswer> {
  // The grader's own allowance (llm/budget.ts) — deliberately not the watching
  // cap, which must never be spent down by grading.
  const budget = await checkGradeBudget(deps.db, orgId);
  if (budget.over) {
    return { outcome: 'cannot_tell', detail: 'grading paused for today — the daily grading allowance is used up' };
  }

  const result = await deps.llm.complete({
    model: deps.model,
    system: promptTemplate(),
    userContent: `What was asked:\n${spec.ask}\n\nWhat changed:\n${spec.evidence}`,
    maxTokens: MAX_TOKENS,
    schema: GRADE_SCHEMA as unknown as Record<string, unknown>,
  });

  // Success or failure, the call cost money and is recorded — no production
  // call without a usage row.
  await recordUsage(deps.db, orgId, 'grade', result);

  if (!result.ok) {
    return { outcome: 'cannot_tell', detail: `the grader could not be reached (${result.reason})` };
  }

  const json = result.json as { outcome?: unknown; reason?: unknown };
  const outcome = json?.outcome;
  if (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'cannot_tell') {
    // A malformed answer is not an answer. Strict mode makes this unreachable
    // in practice; the guard stays because "unreachable in practice" is not a
    // property to bet a verdict on.
    return { outcome: 'cannot_tell', detail: 'the grader gave an unusable answer' };
  }

  const reason = typeof json.reason === 'string' && json.reason.trim() !== '' ? json.reason.trim() : null;
  return { outcome, detail: reason };
}
