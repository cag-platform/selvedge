import { describe, it, expect } from 'vitest';
import { collapseRepeatedLines, withTimesSuffix } from '../../src/shared/repeats.js';
import { estimateTokens } from '../../src/shared/tokens.js';

describe('collapsing repeats — one fact that happened often, not many facts', () => {
  it('keeps first-seen order and says the count plainly', () => {
    expect(collapseRepeatedLines(['Running: npm test', 'Editing a.ts', 'Running: npm test', 'Running: npm test'])).toEqual([
      'Running: npm test (3 times)',
      'Editing a.ts',
    ]);
  });

  it('puts the count inside the sentence, before the full stop', () => {
    expect(withTimesSuffix('New work landed today.', 3)).toBe('New work landed today (3 times).');
    expect(withTimesSuffix('Editing a.ts', 2)).toBe('Editing a.ts (2 times)');
  });

  it('leaves a list with nothing repeated exactly as it was', () => {
    expect(collapseRepeatedLines(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(collapseRepeatedLines([])).toEqual([]);
  });
});

describe('estimating tokens — a ruler, never a bill', () => {
  it('grows with the text and never claims a token for nothing', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
    expect(estimateTokens('x'.repeat(800))).toBeGreaterThan(estimateTokens('x'.repeat(400)));
  });
});
