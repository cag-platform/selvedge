import { describe, it, expect } from 'vitest';
import {
  isDocumentSized,
  nameForPaste,
  sayLength,
  boundDocuments,
  renderDocuments,
  PASTE_BECOMES_DOCUMENT,
  MAX_DOCUMENTS,
} from '../../src/shared/documents.js';

/**
 * A paste too big to be a sentence stops being text in the box and becomes a
 * thing attached to the message. Two reasons it is its own concept rather than
 * "a long message": the composer stays readable, and a document gets its own
 * budget instead of crowding out the sentence explaining what to do with it.
 */
describe('shared/documents — a paste too long to be a sentence', () => {
  it('leaves an ordinary paste alone', () => {
    // The things people legitimately paste and expect to SEE: an error, a
    // stack trace, a function.
    expect(isDocumentSized('Error: connection refused\n  at Object.<anonymous>')).toBe(false);
    expect(isDocumentSized('x'.repeat(PASTE_BECOMES_DOCUMENT - 1))).toBe(false);
    expect(isDocumentSized('x'.repeat(PASTE_BECOMES_DOCUMENT))).toBe(true);
  });

  describe('naming it after what it says', () => {
    // Three chips reading "Pasted text" are three chips you must open to tell
    // apart, which is the filing cabinet this feature exists to avoid.
    it('takes a markdown heading when there is one', () => {
      expect(nameForPaste('# The Selvedge rundown\n\nlots of words')).toBe('The Selvedge rundown');
      expect(nameForPaste('intro line\n\n## Voice notes\n\nmore')).toBe('Voice notes');
    });

    it('otherwise takes the first line with words in it', () => {
      expect(nameForPaste('\n\n   \nRefunds go back to the original card\nand then some')).toBe('Refunds go back to the original card');
    });

    it('trims a very long first line rather than letting it run', () => {
      const name = nameForPaste('a'.repeat(400));
      expect(name.length).toBeLessThanOrEqual(60);
      expect(name.endsWith('…')).toBe(true);
    });

    it('falls back only when there is genuinely nothing to read', () => {
      expect(nameForPaste('   \n\n  ')).toBe('Pasted text');
      expect(nameForPaste('...', 'Something')).toBe('Something');
    });
  });

  describe('bounding what arrives', () => {
    it('keeps the name and the text', () => {
      const [doc] = boundDocuments([{ name: 'Rundown', text: 'hello' }]);
      expect(doc).toEqual({ name: 'Rundown', text: 'hello' });
    });

    it('names one that arrived without a name', () => {
      expect(boundDocuments([{ text: '# Pricing\n\nbody' }])[0]!.name).toBe('Pricing');
    });

    it('says when it clipped, rather than clipping in silence', () => {
      // A document cut without saying so is the same shape of lie as an import
      // that drops 300 entries: what came back looks complete.
      const [doc] = boundDocuments([{ text: 'x'.repeat(500) }], { maxChars: 100 });
      expect(doc!.text).toContain('clipped here');
      expect(doc!.text).toContain('500 characters');
    });

    it('takes no more than the cap, and drops the empty', () => {
      const many = boundDocuments(Array.from({ length: 20 }, (_, i) => ({ text: `document ${i}` })));
      expect(many).toHaveLength(MAX_DOCUMENTS);
      expect(boundDocuments([{ text: '   ' }, { text: 'real' }])).toHaveLength(1);
    });

    it('ignores anything that isn\'t text', () => {
      expect(boundDocuments([{ text: 42 }, { name: 'x' }, null as never])).toEqual([]);
    });
  });

  describe('how it reaches whoever answers', () => {
    it('names each one and says how big it is', () => {
      const rendered = renderDocuments([{ name: 'Rundown', text: 'a'.repeat(1234) }]);
      expect(rendered).toContain('--- Rundown (1,234 characters) ---');
      expect(rendered).toContain('The owner attached this to the message');
    });

    it('is nothing at all when nothing was attached', () => {
      expect(renderDocuments([])).toBeNull();
    });
  });

  it('says a size the way a person would', () => {
    expect(sayLength(1234)).toBe('1,234 characters');
  });
});
