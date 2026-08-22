import { describe, it, expect } from 'vitest';
import { candidatesMatching, referenceNote, type ReferenceCandidate } from '../../src/client/lib/references.js';

const items: ReferenceCandidate[] = [
  { kind: 'project', id: 'loom', name: 'Loom' },
  { kind: 'project', id: 'peas-bees', name: 'Peas&Bees Co' },
  { kind: 'subject', id: 's1', name: 'Taxes' },
  { kind: 'conversation', id: 't1', name: 'diabetes app ideas', note: 'imported from ChatGPT' },
  { kind: 'conversation', id: 't2', name: 'Pricing thinking' },
];

describe('client/references — the # picker\'s own rules', () => {
  it('offers everything the moment # is typed', () => {
    expect(candidatesMatching(items, '')).toHaveLength(items.length);
  });

  it('is more forgiving than the resolver, on purpose', () => {
    // Here a substring match helps you FIND the thing and you then pick it, so
    // a loose match costs a glance. The resolver stays strict because there
    // nobody is looking, and a loose match would hand over the wrong project.
    expect(candidatesMatching(items, 'bees').map((c) => c.name)).toEqual(['Peas&Bees Co']);
    expect(candidatesMatching(items, 'ideas').map((c) => c.name)).toEqual(['diabetes app ideas']);
  });

  it('forgives punctuation and case', () => {
    expect(candidatesMatching(items, 'peas&bees').map((c) => c.name)).toEqual(['Peas&Bees Co']);
    expect(candidatesMatching(items, 'LOOM').map((c) => c.name)).toEqual(['Loom']);
  });

  it('puts the most grounded thing first', () => {
    const names = candidatesMatching(items, '').map((c) => c.kind);
    expect(names).toEqual(['project', 'project', 'subject', 'conversation', 'conversation']);
  });

  describe('what the send is about to read, said before it is pressed', () => {
    it('names what will come in', () => {
      expect(referenceNote('like #loom', items)).toBe('Reading Loom alongside this.');
    });

    it('carries the imported mark into the composer, not just the thread', () => {
      // The owner should know BEFORE sending that they are about to bring in
      // something they said to somebody else's product.
      expect(referenceNote('building on #"diabetes app ideas"', items)).toContain('imported from ChatGPT');
    });

    it('says plainly when a name matches nothing', () => {
      expect(referenceNote('what about #nonesuch', items)).toContain('nothing by that name');
    });

    it('is silent when nothing was referenced', () => {
      expect(referenceNote('just a question', items)).toBeNull();
    });
  });
});
