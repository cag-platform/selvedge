import type { Verdict } from '../narration/types.js';
import { VERDICT_PHRASE } from '../narration/verdictText.js';

/**
 * Post-composition validator (Phase 2 deliverable 6) — code, not model.
 * Runs on every composed brief before it's stored; a violation triggers one
 * recomposition with the violation named, a second failure falls back to
 * the mechanical Phase 1 digest. The brief always sends.
 */

export type ComposerInputSummary = {
  /** Verdicts present in the input fragments — every one must survive into the output. */
  verdicts: Verdict[];
  /** Project names present in the input — no other known project may be named in the output. */
  inputProjectNames: string[];
  /** Every project name known to the org (the whitelist's complement source). */
  allKnownProjectNames: string[];
  /** Attention fragments given to the composer — pre-composition must have capped these at 3. */
  attentionCount: number;
  wordBudget: number;
};

export type ValidationResult = { ok: true } | { ok: false; violations: string[] };

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function validateComposedBrief(brief: string, input: ComposerInputSummary): ValidationResult {
  const violations: string[] = [];
  const lower = brief.toLowerCase();

  // 1. Word budget (the eval harness gates at budget +10%; the validator
  //    allows the same headroom so the two never disagree).
  const limit = Math.ceil(input.wordBudget * 1.1);
  const words = wordCount(brief);
  if (words > limit) {
    violations.push(`word budget exceeded: ${words} words > ${limit} (budget ${input.wordBudget} +10%)`);
  }

  // 2. Max 3 attention items — enforced pre-composition; validated here as
  //    an invariant so a selection bug can't smuggle a fourth past review.
  if (input.attentionCount > 3) {
    violations.push(`pre-composition handed the model ${input.attentionCount} attention items (max 3)`);
  }

  // 3. Every input verdict present with meaning preserved — string
  //    containment on the canonical verdict rendering.
  for (const verdict of new Set(input.verdicts)) {
    if (!lower.includes(VERDICT_PHRASE[verdict])) {
      violations.push(`verdict "${verdict}" dropped or softened: output must contain "${VERDICT_PHRASE[verdict]}"`);
    }
  }

  // 4. No project names absent from input — the composer must not resurrect
  //    a project it wasn't given (that's invention).
  const allowed = new Set(input.inputProjectNames.map((n) => n.toLowerCase()));
  for (const name of input.allKnownProjectNames) {
    if (!allowed.has(name.toLowerCase()) && new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(brief)) {
      violations.push(`project "${name}" named in output but absent from input fragments`);
    }
  }

  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
