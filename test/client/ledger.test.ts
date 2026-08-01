import { describe, it, expect } from 'vitest';
import { entryEdge, outcomeLabel, formatCents } from '../../src/client/lib/ledger.js';

describe('entryEdge — a miss is never dressed as a win', () => {
  it('only a clean verdict is healthy', () => {
    expect(entryEdge({ outcome: 'done', verdict: 'verified' })).toBe('healthy');
    expect(entryEdge({ outcome: 'done', verdict: 'probably' })).toBe('healthy');
  });

  it('a stopped, failed, or unclear finish is dashed unknown', () => {
    expect(entryEdge({ outcome: 'stopped', verdict: 'stopped' })).toBe('unknown');
    expect(entryEdge({ outcome: 'failed', verdict: null })).toBe('unknown');
    expect(entryEdge({ outcome: 'done', verdict: 'didnt_work' })).toBe('unknown');
    expect(entryEdge({ outcome: 'done', verdict: 'inconclusive' })).toBe('unknown');
  });

  it('a deliberate decline reads as a closed choice, not a failure', () => {
    expect(entryEdge({ outcome: 'declined', verdict: null })).toBe('working');
  });
});

describe('outcomeLabel — plain words, verdict folded in', () => {
  it('names the done verdict and the non-done outcomes', () => {
    expect(outcomeLabel({ outcome: 'done', verdict: 'verified' })).toBe('Verified');
    expect(outcomeLabel({ outcome: 'done', verdict: 'didnt_work' })).toMatch(/didn't work/i);
    expect(outcomeLabel({ outcome: 'declined', verdict: null })).toBe('Declined');
    expect(outcomeLabel({ outcome: 'failed', verdict: null })).toMatch(/couldn't finish/i);
  });
});

describe('formatCents', () => {
  it('formats dollars', () => {
    expect(formatCents(1900)).toBe('$19.00');
  });
});
