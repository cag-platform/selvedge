import { describe, it, expect } from 'vitest';
import {
  referencedNames,
  hasReference,
  referenceQuery,
  completeReference,
  referenceLine,
  MAX_REFERENCES,
} from '../../src/shared/references.js';
import { mentionIntent } from '../../src/shared/mentions.js';

/**
 * `#` says WHAT WE ARE TALKING ABOUT; `@` says WHO ANSWERS. Two marks because
 * they are two questions — and because folding them together would make a
 * project called "codex" permanently ambiguous with the agent of that name.
 */
describe('shared/references — pointing at another conversation', () => {
  it('reads a name out of the sentence', () => {
    expect(referencedNames('how does #loom handle refunds?')).toEqual(['loom']);
  });

  it('reads a quoted name, because history has spaces in it', () => {
    // An imported ChatGPT conversation is called whatever it was called. Asking
    // somebody to rename their own history before they can point at it is not
    // a design, it is a chore.
    expect(referencedNames('what did I decide in #"diabetes app ideas"?')).toEqual(['diabetes app ideas']);
  });

  it('keeps the case people typed', () => {
    // These are matched against titles somebody chose; echoing back a
    // lowercased version of their own words looks like a bug.
    expect(referencedNames('see #Peas&Bees')).toEqual(['Peas']);
    expect(referencedNames('see #"Peas&Bees Co"')).toEqual(['Peas&Bees Co']);
  });

  it('needs a word boundary, so a URL fragment donates nothing', () => {
    expect(referencedNames('https://example.com/docs#install')).toEqual([]);
    expect(referencedNames('issue no35#install')).toEqual([]);
  });

  it('reads a hex colour as a name, and that is fine', () => {
    // The boundary rule can't tell `#fff` from a project called `fff`, and
    // shouldn't try: like an unrecognised @name, a reference to nothing
    // resolves to nothing and is dropped without comment. Refusing to send a
    // message because it contained a stylesheet would be absurd, and the line
    // the conversation records means a reference is never silent when it DOES
    // land.
    expect(referencedNames('the brand navy is #1A1F36')).toEqual(['1A1F36']);
    expect(referencedNames('a{color:#fff}')).toEqual(['fff']);
  });

  it('keeps the order written and drops repeats', () => {
    expect(referencedNames('#loom then #mirror then #LOOM again')).toEqual(['loom', 'mirror']);
  });

  it('stops at the cap, because every one of these costs context', () => {
    const many = referencedNames('#a #b #c #d #e');
    expect(many).toHaveLength(MAX_REFERENCES);
    expect(many).toEqual(['a', 'b', 'c']);
  });

  it('shares no namespace with @', () => {
    // The whole reason for a second sigil: naming a project must never change
    // who answers, and naming an agent must never pull in a project.
    const text = '@gpt how does #codex compare?';
    expect(mentionIntent(text)).toEqual({ kind: 'direct', agent: 'gpt' });
    expect(referencedNames(text)).toEqual(['codex']);
  });

  it('says whether a message points at anything', () => {
    expect(hasReference('plain words')).toBe(false);
    expect(hasReference('about #loom')).toBe(true);
  });

  describe('the picker, mid-typing', () => {
    it('offers everything the moment # is typed', () => {
      // '' and null are different answers: one means "show me the list", the
      // other means "you are not referencing anything". Collapsing them would
      // make the picker never open.
      expect(referenceQuery('how does #')).toBe('');
      expect(referenceQuery('how does ')).toBeNull();
    });

    it('narrows as you type, quoted or not', () => {
      expect(referenceQuery('how does #loo')).toBe('loo');
      expect(referenceQuery('what about #"diabetes ap')).toBe('diabetes ap');
    });

    it('closes once the reference is finished', () => {
      expect(referenceQuery('#"diabetes app ideas" said')).toBeNull();
    });

    it('is not fooled by a # inside a word', () => {
      expect(referenceQuery('issue no35#')).toBeNull();
    });
  });

  describe('completing a pick', () => {
    it('replaces what was typed, and quotes what needs it', () => {
      expect(completeReference('how does #loo', 'loom')).toBe('how does #loom ');
      expect(completeReference('what about #dia', 'diabetes app ideas')).toBe('what about #"diabetes app ideas" ');
    });

    it('completes a bare # at the very start', () => {
      expect(completeReference('#', 'loom')).toBe('#loom ');
    });

    it('leaves a message alone when nothing is being typed', () => {
      expect(completeReference('nothing here', 'loom')).toBe('nothing here');
    });
  });

  describe('the line the conversation records', () => {
    it('says what was read and that nothing there moved', () => {
      const line = referenceLine([{ label: 'Loom' }]);
      expect(line).toContain('Loom');
      expect(line).toContain('nothing there was changed');
    });

    it('carries the imported mark through rather than laundering it', () => {
      // What you told ChatGPT in March is worth knowing and is NOT the same as
      // something decided here. A reference that quietly turns the first into
      // the second is the false-calm rule wearing a different coat.
      const line = referenceLine([{ label: 'diabetes app ideas', note: 'imported from ChatGPT' }]);
      expect(line).toContain('imported from ChatGPT');
    });

    it('reads as a list when several came in', () => {
      expect(referenceLine([{ label: 'Loom' }, { label: 'Mirror' }])).toContain('Loom and Mirror');
    });
  });
});
