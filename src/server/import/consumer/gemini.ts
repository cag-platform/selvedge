import { isoFrom, tidy, type ImportedConversation, type ParseResult, type UnreadableItem } from './types.js';

/**
 * Gemini, via Google Takeout's `My Activity/Gemini Apps/MyActivity.json`.
 *
 * This one is different in kind from the other two, and the difference must be
 * said out loud rather than papered over: Takeout's activity log records WHAT
 * YOU ASKED, entry by entry, not the conversation you had. There are no
 * conversation ids, no threading, and in the JSON export no model replies.
 *
 * So this reader deliberately does the boring thing. One activity entry becomes
 * one imported conversation holding one message: yours. It does not group
 * consecutive prompts into a "chat", because the export contains nothing that
 * says where one chat ended and the next began — inventing those boundaries
 * would produce transcripts that never happened, which is exactly the failure
 * the honesty rule exists to prevent.
 *
 * Written against Takeout's documented shape rather than against a real export.
 * Anything that doesn't match lands in `unreadable` and is reported, so a
 * format change shows up as "I couldn't read 400 of these" instead of silence.
 */

type Entry = {
  header?: unknown;
  title?: unknown;
  time?: unknown;
  products?: unknown;
};

const PROMPT_PREFIX = /^Prompted\s+/i;

function parseOne(raw: unknown, index: number): ImportedConversation | UnreadableItem {
  if (!raw || typeof raw !== 'object') return { ref: `#${index}`, reason: 'not an object' };
  const entry = raw as Entry;
  const title = entry.title;
  if (typeof title !== 'string' || title.trim() === '') return { ref: `#${index}`, reason: 'no title — nothing was recorded about what was asked' };

  // Takeout writes "Prompted <what you typed>" for a prompt, and other verbs
  // ("Used Gemini in…", "Deleted…") for things that are not questions.
  if (!PROMPT_PREFIX.test(title)) return { ref: `#${index}`, reason: `not a prompt: "${title.slice(0, 60)}"` };
  const prompt = tidy(title.replace(PROMPT_PREFIX, ''));
  if (prompt === '') return { ref: `#${index}`, reason: 'the prompt was empty' };

  const at = isoFrom(entry.time);
  return {
    // No conversation id exists, so the id is the entry's own coordinates —
    // stable across re-imports of the same export, which is what dedupe needs.
    sourceId: `gemini:${at ?? 'undated'}:${index}`,
    title: prompt.split('\n')[0]!.slice(0, 120),
    startedAt: at,
    messages: [{ role: 'owner', content: prompt, at }],
  };
}

export function parseGeminiExport(json: unknown): ParseResult {
  if (!Array.isArray(json)) {
    return { conversations: [], unreadable: [{ ref: 'MyActivity.json', reason: 'the file is not a list of activity entries' }], limitations: [] };
  }
  const conversations: ImportedConversation[] = [];
  const unreadable: UnreadableItem[] = [];
  json.forEach((raw, i) => {
    const result = parseOne(raw, i);
    if ('reason' in result) unreadable.push(result);
    else conversations.push(result);
  });
  return {
    conversations,
    unreadable,
    limitations: [
      "Google's export is an activity log, not a transcript: it records what you asked Gemini and not what Gemini answered. These arrive as your questions alone.",
      'For the same reason there are no conversations — each question comes in on its own, because nothing in the export says which ones belonged together.',
    ],
  };
}
