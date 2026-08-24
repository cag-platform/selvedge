/**
 * CONSUMER-HISTORY IMPORT — the shape every export becomes.
 *
 * Three vendors, three unrelated file formats, one thing worth keeping: what
 * was said, by whom, when, under what heading. Everything else in these
 * exports (model ids, node graphs, feedback flags, tool payloads) is theirs,
 * not ours, and is dropped rather than half-understood.
 *
 * The discipline these parsers inherit from the connectors: what cannot be
 * read is REPORTED, never silently skipped. A quiet drop is how an import
 * turns into "I have all my history" when a third of it never arrived — the
 * same shape of lie as a confidently wrong all-clear.
 */

export type ImportedMessage = {
  role: 'owner' | 'agent';
  content: string;
  /** ISO, or null when the export didn't say and we refuse to invent one. */
  at: string | null;
};

export type ImportedConversation = {
  /** The vendor's own id, so a re-import updates rather than duplicates. */
  sourceId: string;
  title: string;
  startedAt: string | null;
  messages: ImportedMessage[];
};

/** One thing in the file that could not be read, and what little we can say about it. */
export type UnreadableItem = {
  /** The vendor's id if we got that far, otherwise the position in the file. */
  ref: string;
  reason: string;
};

export type ParseResult = {
  conversations: ImportedConversation[];
  unreadable: UnreadableItem[];
  /**
   * What this format cannot carry at all, in plain words, when that is true of
   * the format rather than of one broken entry. Shown to the person importing
   * so "your Gemini history is in" never means more than it should.
   */
  limitations: string[];
};

export type Vendor = 'chatgpt' | 'claude' | 'gemini' | 'cursor';

export const VENDOR_NAMES: Record<Vendor, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  // Cursor has no export button at all — its history lives in a local SQLite
  // file, so it arrives through the companion CLI rather than a zip upload.
  cursor: 'Cursor',
};

/** Trim, collapse the runs of blank lines these exports are full of, and cap. */
export function tidy(text: string, max = 20_000): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n\n[…truncated on import]` : cleaned;
}

/** Seconds-since-epoch (ChatGPT) or an ISO string (Claude) → ISO, or null. Never a guess. */
export function isoFrom(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // ChatGPT writes float seconds; anything that lands outside a plausible
    // range is a field we've misread, and a wrong date is worse than none.
    const ms = value * 1000;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    return year >= 2015 && year <= 2100 ? date.toISOString() : null;
  }
  if (typeof value === 'string' && value !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/**
 * A conversation's start, when the export didn't say: the first message that
 * carries a date it can stand behind. NOT the first message — an undated
 * opener would otherwise leave the whole conversation undated even though the
 * reply two lines down says exactly when it happened.
 */
export function firstDated(messages: ImportedMessage[]): string | null {
  return messages.find((m) => m.at !== null)?.at ?? null;
}
