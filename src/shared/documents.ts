/**
 * A PASTE TOO BIG TO BE A SENTENCE.
 *
 * People paste whole documents into a composer — a rundown, a spec, a
 * transcript — and ask what somebody makes of it. Inline, that is a wall of
 * text you cannot see past while typing the actual question, and a message the
 * thread then renders as four screens of scrolling.
 *
 * So past a certain size a paste stops being text in the box and becomes a
 * thing attached to the message: one chip in the composer, one chip on the
 * thread, and the whole of it handed to whoever answers.
 *
 * WHY A SEPARATE CONCEPT rather than "a long message". Two reasons that
 * matter. It keeps the composer readable, which is the thing that was actually
 * broken. And it lets a document have its own budget: the question gets room
 * to be a question, and the document gets room to be a document, instead of
 * one shared allowance where a long paste crowds out the sentence explaining
 * what to do with it.
 */

/**
 * Past this, a paste becomes an attachment.
 *
 * Chosen to be well clear of the things people legitimately paste and expect
 * to see: an error message, a stack trace, a function. A page of prose is
 * around 3,000 characters, so this is "several pages" rather than "a long
 * paragraph".
 */
export const PASTE_BECOMES_DOCUMENT = 4_000;

/** What one attached document may carry. Beyond this it is clipped, and said so. */
export const MAX_DOCUMENT_CHARS = 200_000;
/** How many may ride on one message. */
export const MAX_DOCUMENTS = 5;

/** What the composer says when the cap is reached. Said, never silent. */
export const TOO_MANY_DOCUMENTS = `That's more than ${MAX_DOCUMENTS} attached at once — send these first.`;

/**
 * A DOCUMENT IS NOT A SENTENCE. Attaching a rundown and pressing send with no
 * words is a message with no ask in it. This is said beside the chip, before
 * the press — a greyed-out button with no explanation is the thing that makes
 * people think a product is broken.
 */
export const NEEDS_A_QUESTION = 'Say what you would like done with it — an attachment on its own has no question in it.';

export type PastedDocument = {
  /** What it is called on the thread. Derived from the text, or given by the owner. */
  name: string;
  text: string;
};

/** Whether a paste is big enough to become one. */
export function isDocumentSized(text: string): boolean {
  return text.length >= PASTE_BECOMES_DOCUMENT;
}

/**
 * A name for a paste, taken from what it says.
 *
 * A markdown heading if it opens with one, otherwise its first line of real
 * words. "Pasted text" is the last resort rather than the default, because a
 * chip that says "Pasted text" three times is three chips you have to open to
 * tell apart.
 */
export function nameForPaste(text: string, fallback = 'Pasted text'): string {
  const lines = text.split('\n').map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const candidate = heading ? heading.replace(/^#{1,3}\s+/, '') : lines.find((l) => l.length > 0 && /[A-Za-z0-9]/.test(l));
  if (!candidate) return fallback;
  const cleaned = candidate.replace(/[*_`>#]/g, '').trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned || fallback;
}

/** "12,400 characters" — the size, said the way a person would say it. */
export function sayLength(chars: number): string {
  return `${chars.toLocaleString('en-US')} characters`;
}

/**
 * Bound what arrives, and say when something was cut. A document clipped in
 * silence is the same shape of lie as an import that drops 300 entries: what
 * came back looks complete.
 */
export function boundDocuments(
  raw: Array<{ name?: unknown; text?: unknown }>,
  { maxChars = MAX_DOCUMENT_CHARS, max = MAX_DOCUMENTS } = {},
): PastedDocument[] {
  const out: PastedDocument[] = [];
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item.text !== 'string') continue;
    const text = item.text;
    if (text.trim() === '') continue;
    const name = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim().slice(0, 120) : nameForPaste(text);
    out.push({
      name,
      text:
        text.length <= maxChars
          ? text
          : `${text.slice(0, maxChars)}\n\n[…clipped here: this document is ${sayLength(text.length)} and only the first ${sayLength(
              maxChars,
            )} were carried.]`,
    });
  }
  return out;
}

/** How the documents are put in front of whoever is answering. */
export function renderDocuments(documents: PastedDocument[]): string | null {
  if (documents.length === 0) return null;
  const blocks = documents.map((d) => `--- ${d.name} (${sayLength(d.text.length)}) ---\n${d.text}`);
  return `The owner attached ${documents.length === 1 ? 'this' : 'these'} to the message:\n\n${blocks.join('\n\n')}`;
}
