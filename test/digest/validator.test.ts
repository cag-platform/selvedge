import { describe, it, expect } from 'vitest';
import { validateComposedBrief, type ComposerInputSummary } from '../../src/server/digest/validator.js';

const base: ComposerInputSummary = {
  verdicts: ['users_fine'],
  inputProjectNames: ['Loom', 'Mirror'],
  allKnownProjectNames: ['Loom', 'Mirror', 'YOKE'],
  attentionCount: 1,
  wordBudget: 100,
};

describe('digest/validator', () => {
  it('accepts a brief that keeps verdict phrases, stays in budget, names only input projects', () => {
    const brief = "Loom's deploy failed but users are fine — the previous version is serving. Mirror was quiet.";
    expect(validateComposedBrief(brief, base)).toEqual({ ok: true });
  });

  it('fails when a verdict phrase is dropped', () => {
    const brief = "Loom's deploy failed. Mirror was quiet."; // no "users are fine"
    const result = validateComposedBrief(brief, base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join(' ')).toMatch(/users_fine/);
  });

  it('fails when a softened verdict drops the canonical phrase', () => {
    const brief = 'Loom had a hiccup, probably nothing. Mirror was quiet.';
    expect(validateComposedBrief(brief, base).ok).toBe(false);
  });

  it('fails when the word budget (+10%) is exceeded', () => {
    const brief = 'users are fine ' + 'word '.repeat(120);
    const result = validateComposedBrief(brief, { ...base, wordBudget: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join(' ')).toMatch(/word budget/);
  });

  it('fails when the output names a known project absent from the input', () => {
    const brief = 'users are fine. Loom shipped. YOKE is still waiting on checkout.'; // YOKE not in input
    const result = validateComposedBrief(brief, base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations.join(' ')).toMatch(/YOKE/);
  });

  it('fails the pre-composition invariant when more than 3 attention items were handed over', () => {
    const result = validateComposedBrief('users are fine.', { ...base, attentionCount: 4 });
    expect(result.ok).toBe(false);
  });

  it('checks every distinct verdict in the input', () => {
    const input: ComposerInputSummary = { ...base, verdicts: ['users_affected', 'cannot_tell'] };
    const missingBoth = validateComposedBrief('Something broke somewhere.', input);
    expect(missingBoth.ok).toBe(false);
    if (!missingBoth.ok) expect(missingBoth.violations).toHaveLength(2);

    const good = validateComposedBrief(
      "YOKE is down — users are affected. Loom's migration: can't tell yet, checking the schema.",
      { ...input, inputProjectNames: ['Loom', 'Mirror', 'YOKE'] },
    );
    expect(good.ok).toBe(true);
  });
});
