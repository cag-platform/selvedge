import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { LlmClient } from '../src/server/llm/types.js';
import { composeModel } from '../src/server/llm/config.js';

/**
 * Model-graded style similarity against Greg's golden briefs — REPORTED,
 * never gated (taste is Greg's call in review, not CI's). Runs only with a
 * real API key; hermetic runs print the mapping and skip.
 */

const GOLDENS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/golden-set');

/** golden file -> the fixture whose composed brief it's graded against. null = no comparable pipeline output yet. */
export const GOLDEN_FIXTURE_MAP: Record<string, string | null> = {
  'quiet-day.md': 'golden-quiet-day',
  'storm-day.md': 'golden-storm-day',
  // These two goldens' frozen inputs (first real transactions; a stuck GPU
  // scan) aren't representable in the Phase 1 event vocabulary — graded
  // against the nearest synthetic day for register/tone only.
  'mixed-day.md': 'mixed-day',
  'degraded-trust-day.md': 'degraded-trust-day',
  // The first-day orientation brief is a composer mode that doesn't exist
  // yet (composer always narrates a day, never an inventory) — flagged.
  'first-day.md': null,
};

export type GoldenMeta = { file: string; register: string; budget: number | null };

export function readGoldenMeta(file: string): GoldenMeta | null {
  const fullPath = path.join(GOLDENS_DIR, file);
  if (!existsSync(fullPath)) return null;
  const text = readFileSync(fullPath, 'utf-8');
  const register = text.match(/Register:\s*([a-z_]+)/i)?.[1] ?? 'unknown';
  const budget = text.match(/Budget\s*≤\s*(\d+)/)?.[1];
  return { file, register, budget: budget ? Number(budget) : null };
}

export function readGoldenReferenceBrief(file: string): string | null {
  const fullPath = path.join(GOLDENS_DIR, file);
  if (!existsSync(fullPath)) return null;
  const text = readFileSync(fullPath, 'utf-8');
  const match = text.match(/## Reference brief\s*\n([\s\S]*?)(\n## |$)/);
  return match?.[1]?.trim() ?? null;
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    similarity_0_10: { type: 'integer' },
    register_match: { type: 'string', enum: ['yes', 'partial', 'no'] },
    notes: { type: 'string' },
  },
  required: ['similarity_0_10', 'register_match', 'notes'],
  additionalProperties: false,
} as const;

export type StyleGrade = { similarity: number; registerMatch: string; notes: string };

export async function gradeStyle(llm: LlmClient, goldenBrief: string, composedBrief: string): Promise<StyleGrade | null> {
  const result = await llm.complete({
    model: composeModel(),
    system:
      'You grade the STYLE similarity of a machine-composed morning brief against a hand-written reference brief: register, warmth, verdict-first structure, economy, absence of dashboard/marketing tone. Ignore factual differences — the two briefs describe different days by design. Respond with JSON only.',
    userContent: JSON.stringify({ reference_brief: goldenBrief, composed_brief: composedBrief }, null, 2),
    maxTokens: 512,
    schema: GRADE_SCHEMA as unknown as Record<string, unknown>,
  });
  if (!result.ok) return null;
  const json = result.json as { similarity_0_10?: number; register_match?: string; notes?: string };
  if (typeof json.similarity_0_10 !== 'number') return null;
  return { similarity: json.similarity_0_10, registerMatch: json.register_match ?? 'unknown', notes: json.notes ?? '' };
}
