import { AGENTS } from '../../shared/agents.js';

/**
 * WORDS THAT ARE NOT SUBJECT MATTER.
 *
 * Lifted out of references/resolve.ts, where it was written, so the two things
 * that decide "what is this conversation about" share one answer. They are
 * asked the same question — the reference finder asks it of a sentence, the
 * filing suggester asks it of a whole conversation — and two lists would drift
 * into one surface being careful and the other confidently wrong.
 *
 * WHY THIS EXISTS AT ALL. Postgres's english dictionary drops grammar and
 * keeps everything else, so "give me your thoughts on what could make this
 * better" is, to a full-text query, a sentence about `thoughts` and `better`.
 * Matching on those is matching on the fact that it was a conversation.
 *
 * The filler half is deliberately conservative — meta-vocabulary, not weak
 * nouns. "Work", "add" and "use" are NOT here: they are vague, but a person
 * really can be looking for the chat where they worked something out.
 */
export const NO_SUBJECT: ReadonlySet<string> = new Set([
  // Grammar.
  'and', 'the', 'for', 'are', 'but', 'not', 'you', 'your', 'yours', 'its', 'our', 'ours',
  'his', 'her', 'hers', 'him', 'she', 'they', 'them', 'their', 'theirs', 'this', 'that',
  'these', 'those', 'was', 'were', 'been', 'being', 'has', 'had', 'have', 'having',
  'can', 'could', 'would', 'should', 'shall', 'will', 'may', 'might', 'must', 'does', 'did',
  'with', 'from', 'into', 'onto', 'out', 'off', 'over', 'under', 'than', 'then', 'when',
  'where', 'which', 'while', 'what', 'who', 'whom', 'why', 'how', 'all', 'any', 'both',
  'each', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'very',
  'just', 'now', 'once', 'again', 'because', 'before', 'after', 'during', 'until', 'through',
  'between', 'above', 'below', 'down', 'few', 'nor', 'get', 'got',
  // Filler.
  'think', 'thinks', 'thinking', 'thought', 'thoughts',
  'give', 'gives', 'giving', 'given',
  'make', 'makes', 'making', 'made',
  'better', 'best', 'good', 'great', 'well',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed',
  'know', 'knows', 'tell', 'tells', 'say', 'says', 'said',
  'look', 'looks', 'looking', 'looked', 'see', 'seen',
  'help', 'please', 'thanks', 'thank', 'sure', 'really', 'actually', 'maybe',
  'thing', 'things', 'stuff', 'kind', 'sort', 'lot', 'bit',
  'also', 'still', 'even', 'here', 'there', 'about',
  'question', 'questions', 'answer', 'answers',
  'anything', 'something', 'everything', 'nothing', 'someone', 'anyone',
  // The agents themselves. Stripped as `@mentions` already; this catches the
  // plain-text form ("ask claude what he thinks"), which is the same routing
  // instruction wearing different punctuation.
  ...AGENTS.map((a) => a.id.replace(/-/g, '')),
  ...AGENTS.flatMap((a) => a.id.split('-')),
  ...AGENTS.map((a) => a.name.toLowerCase()),
]);

/** The words in a string that are about anything, lowercased and deduplicated. */
export function subjectTerms(text: string, limit = 24): string[] {
  return [...new Set((text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((t) => !NO_SUBJECT.has(t))
    .slice(0, limit);
}
