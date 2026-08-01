import { describe, it, expect } from 'vitest';
import { percentile, costStatsForRisk, learnedEstimate, MIN_SAMPLES } from '../../src/server/ledger/costs.js';
import type { LedgerEntry } from '../../src/server/ledger/entries.js';

function entry(o: Partial<LedgerEntry> & { spentCents: number; risk?: LedgerEntry['risk'] }): LedgerEntry {
  return {
    cardId: 'c', projectId: 'loom', trigger: 'request', intent: 'x', risk: o.risk ?? 'ordinary',
    outcome: 'done', verdict: 'verified', didWork: true, at: '2026-08-01T00:00:00Z', ...o,
  };
}

const FALLBACK = { estimate: { lowCents: 300, highCents: 1200 }, capCents: 3000 };

describe('percentile', () => {
  it('interpolates and handles the ends', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([100], 50)).toBe(100);
    expect(percentile([100, 200, 300], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 90)).toBeCloseTo(370, 0);
  });
});

describe('learnedEstimate — the flywheel: cheaper the second time', () => {
  it('falls back to the default until there is enough history', () => {
    const few = [entry({ spentCents: 500 }), entry({ spentCents: 600 })]; // 2 < MIN_SAMPLES
    const r = learnedEstimate(few, 'ordinary', FALLBACK);
    expect(r.basis).toBe('default');
    expect(r.estimate).toEqual(FALLBACK.estimate);
    expect(few.length).toBeLessThan(MIN_SAMPLES);
  });

  it('learns the range and cap from history once there is enough', () => {
    const many = [400, 450, 500, 550, 600].map((c) => entry({ spentCents: c }));
    const r = learnedEstimate(many, 'ordinary', FALLBACK);
    expect(r.basis).toBe('history');
    expect(r.samples).toBe(5);
    // The learned range sits inside the observed spread, tighter than the default.
    expect(r.estimate.lowCents).toBeGreaterThanOrEqual(400);
    expect(r.estimate.highCents).toBeLessThanOrEqual(600);
  });

  it('only counts the matching risk class and real work', () => {
    const mixed = [
      entry({ spentCents: 5000, risk: 'sensitive' }), // wrong class
      entry({ spentCents: 0, risk: 'ordinary' }), // no spend
      entry({ spentCents: 100, risk: 'ordinary', didWork: false }), // declined
      ...[400, 500, 600].map((c) => entry({ spentCents: c, risk: 'ordinary' })),
    ];
    const stats = costStatsForRisk(mixed, 'ordinary');
    expect(stats.samples).toBe(3); // only the three real ordinary changes
    expect(stats.medianCents).toBe(500);
  });

  it('never lowers the cap below the default safety floor', () => {
    // Cheap history shouldn't strip the safety margin on a run that spikes.
    const cheap = [100, 120, 140].map((c) => entry({ spentCents: c }));
    const r = learnedEstimate(cheap, 'ordinary', FALLBACK);
    expect(r.capCents).toBeGreaterThanOrEqual(FALLBACK.capCents);
  });
});
