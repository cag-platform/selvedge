import { describe, it, expect } from 'vitest';
import { summarize } from '../../src/server/ledger/summary.js';
import type { LedgerEntry } from '../../src/server/ledger/entries.js';

function e(o: Partial<LedgerEntry> & { verdict: LedgerEntry['verdict']; outcome: LedgerEntry['outcome']; spentCents: number }): LedgerEntry {
  return {
    cardId: 'c', projectId: 'loom', trigger: 'request', intent: 'x', risk: 'ordinary',
    didWork: true, at: '2026-08-01T00:00:00Z', ...o,
  };
}

describe('summarize — honest about the misses', () => {
  it('counts only verified/probably as shipped, but keeps everything in the total and spend', () => {
    const s = summarize([
      e({ verdict: 'verified', outcome: 'done', spentCents: 500 }),
      e({ verdict: 'probably', outcome: 'done', spentCents: 700 }),
      e({ verdict: 'didnt_work', outcome: 'done', spentCents: 400 }), // a miss — spent but not shipped
      e({ verdict: 'stopped', outcome: 'stopped', spentCents: 300 }), // halted
      e({ verdict: null, outcome: 'declined', spentCents: 0 }), // never started
    ]);
    expect(s.total).toBe(5);
    expect(s.shipped).toBe(2); // only the two wins
    expect(s.spentCents).toBe(1900); // all spend counted, misses included
    expect(s.byOutcome.done).toBe(3);
    expect(s.byOutcome.declined).toBe(1);
    expect(s.byVerdict.didnt_work).toBe(1);
  });

  it('an empty ledger summarizes to zeroes', () => {
    expect(summarize([])).toEqual({ total: 0, shipped: 0, spentCents: 0, byVerdict: {}, byOutcome: {} });
  });
});
