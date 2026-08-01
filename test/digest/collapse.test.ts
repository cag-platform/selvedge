import { describe, it, expect } from 'vitest';
import { collapseRepeats, type NarrationWithPack } from '../../src/server/digest/order.js';

function item(projectId: string | null, fragment: string | null, id = Math.random().toString(36).slice(2)): NarrationWithPack {
  return {
    id,
    projectId,
    fragment,
    kind: 'moved',
    verdict: null,
    technicalDetail: null,
    eventId: 'evt',
    eventType: 'code.commits_landed_default',
    occurredAt: new Date('2026-08-01T10:00:00Z'),
    meta: null,
    pack: null,
  } as unknown as NarrationWithPack;
}

describe('collapseRepeats — one fact that happened three times, not three lines', () => {
  it('collapses identical (project, fragment) repeats into one line with a plain count', () => {
    const out = collapseRepeats([
      item('smith', 'smith-bespoke: new work landed on the main branch today.', 'first'),
      item('smith', 'smith-bespoke: new work landed on the main branch today.'),
      item('smith', 'smith-bespoke: new work landed on the main branch today.'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.fragment).toBe('smith-bespoke: new work landed on the main branch today (3 times).');
    expect(out[0]!.id).toBe('first'); // feedback/traceability attach to the first occurrence
  });

  it('keeps distinct fragments and distinct projects apart', () => {
    const out = collapseRepeats([
      item('a', 'A: shipped.'),
      item('b', 'B: shipped.'),
      item('a', 'A: something else.'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('the same words on different projects never merge', () => {
    const out = collapseRepeats([item('a', 'new work landed.'), item('b', 'new work landed.')]);
    expect(out).toHaveLength(2);
  });

  it('items without a fragment are never merged with anything', () => {
    const out = collapseRepeats([item('a', null), item('a', null)]);
    expect(out).toHaveLength(2);
  });

  it('a single occurrence is left untouched — no "(1 times)"', () => {
    const out = collapseRepeats([item('a', 'A: shipped.')]);
    expect(out[0]!.fragment).toBe('A: shipped.');
  });

  it('preserves order of first occurrences', () => {
    const out = collapseRepeats([item('a', 'first.'), item('b', 'second.'), item('a', 'first.'), item('c', 'third.')]);
    expect(out.map((o) => o.fragment)).toEqual(['first (2 times).', 'second.', 'third.']);
  });
});
