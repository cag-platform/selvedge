import { describe, it, expect } from 'vitest';
import { priorOccurrence, recallNote } from '../../src/server/ledger/recall.js';
import type { LedgerEntry } from '../../src/server/ledger/entries.js';

function e(o: Partial<LedgerEntry> & { intent: string; verdict: LedgerEntry['verdict'] }): LedgerEntry {
  return {
    cardId: 'c', projectId: 'loom', trigger: 'incident', risk: 'ordinary', outcome: 'done',
    spentCents: 600, didWork: true, at: '2026-08-01T00:00:00Z', ...o,
  };
}

describe('priorOccurrence — conservative matching, latest first', () => {
  it('finds the most recent matching incident (entries are newest-first)', () => {
    const entries = [
      e({ intent: 'Look into why Loom is down', verdict: 'verified', cardId: 'newer' }),
      e({ intent: 'Look into why Loom is down', verdict: 'didnt_work', cardId: 'older' }),
    ];
    expect(priorOccurrence(entries, { intent: 'Look into why Loom is down', trigger: 'incident' })?.cardId).toBe('newer');
  });

  it('does not match a different intent or a different trigger', () => {
    const entries = [e({ intent: 'Look into why Loom is down', verdict: 'verified' })];
    expect(priorOccurrence(entries, { intent: 'Something else', trigger: 'incident' })).toBeNull();
    expect(priorOccurrence(entries, { intent: 'Look into why Loom is down', trigger: 'request' })).toBeNull();
  });

  it('ignores a matching card that never did work (declined)', () => {
    const entries = [e({ intent: 'x', verdict: null, outcome: 'declined', didWork: false })];
    expect(priorOccurrence(entries, { intent: 'x', trigger: 'incident' })).toBeNull();
  });
});

describe('recallNote — honest about how it went last time', () => {
  it('a clean prior is reassuring', () => {
    expect(recallNote(e({ intent: 'x', verdict: 'verified', spentCents: 600 }))).toMatch(/seen this one before/i);
    expect(recallNote(e({ intent: 'x', verdict: 'verified', spentCents: 600 }))).toMatch(/\$6\.00/);
  });

  it('a messy prior is a warning, not hidden', () => {
    expect(recallNote(e({ intent: 'x', verdict: 'didnt_work', outcome: 'done', spentCents: 900 }))).toMatch(/tricky|didn't come out clean/i);
    expect(recallNote(e({ intent: 'x', verdict: 'stopped', outcome: 'stopped', spentCents: 400 }))).toMatch(/stopped partway/i);
  });
});
