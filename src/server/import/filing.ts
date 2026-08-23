import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, threads } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import { NO_SUBJECT } from '../text/subjectWords.js';

/**
 * WHICH PROJECT AN OLD CONVERSATION IS ABOUT.
 *
 * An import lands 407 conversations under "Claude history" and stops. That is
 * a filing cabinet with one drawer: everything is in, nothing is anywhere. The
 * promise is "bring your history and CONTINUE" — and you cannot continue a
 * thing you can only search for.
 *
 * So this reads what came in and says, for each conversation, which project it
 * looks like it belongs to and WHY. It never files anything. Every suggestion
 * carries the words it matched on, so the owner is judging evidence rather
 * than trusting a score.
 *
 * ═══ WHY A WORD MATCH IS NOT ENOUGH, IN THIS ACCOUNT SPECIFICALLY ═══
 *
 * The projects here are called `thread`, `canvas`, `balance`, `mirror`,
 * `drape`, `patina`, `nucleus`, `stopwatch`, `bobbin`, `loom` and `yoke`. Every
 * one is an ordinary English word, and several are words this product uses
 * constantly for something else entirely — a `thread` is the core noun of the
 * Inbox. A suggester that matched a project name against conversation text
 * would file most of a history under `thread` and be confidently, uselessly
 * wrong.
 *
 * Two guards, and they are the whole design:
 *
 * 1. A ONE-WORD NAME HAS TO BE IN THE TITLE. A person titles a conversation
 *    after what it is about, so `toile` in a title is a conversation about
 *    Toile and `toile` in the body is a conversation that mentioned it once.
 *    A multi-word name — "smith bespoke" — is its own evidence anywhere,
 *    because two specific words in that order are not a coincidence.
 *
 *    This rule was written after running the suggester over a real 407-chat
 *    history and reading what it produced. Rarity alone had matched `balance`
 *    to "Tesla lease early termination cost", "Interest calculation on $995
 *    loan" and "ECG payoff number priority" — a rare word, used every time in
 *    its ordinary English sense, nowhere near the project called `balance`.
 *
 * 2. AND IT STILL HAS TO BE RARE. Title-only is not enough on its own: this
 *    account has projects named `thread` and `canvas`, and a history full of
 *    conversations about threads and canvases. Rarity is measured against the
 *    owner's own corpus rather than a list of common words I would have had to
 *    guess at, so it calibrates to a vocabulary I have never seen.
 *
 * 3. AMBIGUITY IS AN ANSWER. This account has `loom` and `cag-platform-loom`,
 *    and four projects that are all about Smith Bespoke. When two projects
 *    match equally well, that conversation gets NO suggestion. "I can't tell"
 *    is the correct output and the house rule; picking one at random to look
 *    useful is how a filing tool loses the right to be trusted with filing.
 */

/** How much of a conversation is read. The subject is established early or not at all. */
const MESSAGES_READ = 6;
const CHARS_PER_MESSAGE = 600;

/**
 * A one-word project name has to appear in fewer than this share of the
 * account's conversations to count as evidence.
 *
 * Deliberately strict. The cost of a missed suggestion is that a conversation
 * stays where it already is, which is where it would have stayed anyway. The
 * cost of a wrong one is an owner opening a project and finding somebody
 * else's subject filed inside it — and, worse, learning that the suggestions
 * are not worth reading.
 */
const RARE_ENOUGH = 0.05;

/** A multi-word name is its own evidence — "smith bespoke" is not a coincidence. */
const PHRASE_TOKENS_TRUSTED = 2;

export type FilingSuggestion = {
  threadId: string;
  title: string;
  /** When the conversation happened, not when it was imported. */
  at: string | null;
  messageCount: number;
  projectId: string;
  projectName: string;
  /** The words that matched. Shown, because a person judging beats a person trusting. */
  because: string[];
  /** Where they matched. A name in the title is a stronger claim than a name in passing. */
  matchedIn: 'title' | 'text';
};

export type FilingReview = {
  /** Imported conversations belonging to no project — the pile. */
  unfiled: number;
  suggestions: FilingSuggestion[];
  /**
   * Conversations that matched more than one project and were therefore left
   * alone. Counted rather than hidden: a silent "no suggestion" and a silent
   * "I couldn't choose" look identical, and only one of them is worth the
   * owner's attention.
   */
  ambiguous: number;
};

/** The distinctive names a project could be called in a sentence. */
type ProjectNames = { projectId: string; name: string; phrases: string[] };

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3);
}

/**
 * What to look for, per project: its display name, its id, and the repo's own
 * name — each as a phrase, hyphens read as spaces so `smith-bespoke` matches
 * "smith bespoke" in a sentence a person wrote.
 *
 * The owner half of a repo (`cag-platform/…`) is deliberately dropped: every
 * project here shares it, so it is the one term guaranteed to be evidence for
 * nothing.
 */
export function namesFor(pack: { projectId: string; name: string; repo: string | null }): ProjectNames {
  const raw = [pack.name, pack.projectId, pack.repo?.split('/').pop() ?? ''];
  const phrases = [
    ...new Set(
      raw
        .map((r) => tokens(r).join(' '))
        .filter((p) => p !== '')
        // A name made entirely of stopwords is not a name we can find.
        .filter((p) => p.split(' ').some((t) => !NO_SUBJECT.has(t))),
    ),
  ];
  return { projectId: pack.projectId, name: pack.name, phrases };
}

/**
 * How many of this org's imported conversations mention each single word —
 * the rarity measurement, done in one pass rather than per candidate.
 */
async function wordFrequency(db: Db, orgId: string, words: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (words.length === 0) return found;

  const rows = await db
    .select({ title: threads.title, id: threads.id })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), isNotNull(threads.importedFrom)));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return found;

  // Title plus opening messages, per conversation — the same text a suggestion
  // is scored against, so the frequency is measured over what is actually read.
  const text = await readOpenings(db, orgId, ids);
  for (const word of words) {
    let count = 0;
    for (const row of rows) {
      const blob = `${row.title} ${text.get(row.id) ?? ''}`.toLowerCase();
      if (new RegExp(`\\b${word}\\b`).test(blob)) count += 1;
    }
    found.set(word, count);
  }
  return found;
}

/** The first few messages of each conversation, clipped. */
async function readOpenings(db: Db, orgId: string, threadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (threadIds.length === 0) return out;

  const rows = await db
    .select({ threadId: agentMessages.threadId, content: agentMessages.content, id: agentMessages.id })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), inArray(agentMessages.threadId, threadIds)))
    .orderBy(agentMessages.threadId, agentMessages.id);

  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.threadId) continue;
    const n = seen.get(row.threadId) ?? 0;
    if (n >= MESSAGES_READ) continue;
    seen.set(row.threadId, n + 1);
    const piece = (row.content ?? '').slice(0, CHARS_PER_MESSAGE);
    out.set(row.threadId, `${out.get(row.threadId) ?? ''} ${piece}`);
  }
  return out;
}

/**
 * Does this text contain the phrase, as whole words?
 *
 * Whole words matter more than it looks: `sild` inside "consilidated" is not a
 * mention of the SILD project, and a substring match would file it there.
 */
function mentions(text: string, phrase: string): boolean {
  return new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}

/**
 * Where each unfiled imported conversation looks like it belongs.
 *
 * Suggestions only. Nothing here writes.
 */
export async function reviewFiling(db: Db, orgId: string, limit = 200): Promise<FilingReview> {
  const packs = await listPacks(db, orgId);
  const projects = packs.map((p) =>
    namesFor({
      projectId: p.identity.project_id,
      name: p.identity.name,
      repo: p.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? null,
    }),
  );

  const pile = await db
    .select({ id: threads.id, title: threads.title, createdAt: threads.createdAt })
    .from(threads)
    .where(
      and(
        eq(threads.orgId, orgId),
        isNotNull(threads.importedFrom),
        isNull(threads.projectId),
        isNull(threads.archivedAt),
      ),
    )
    .orderBy(threads.createdAt);

  if (pile.length === 0) return { unfiled: 0, suggestions: [], ambiguous: 0 };

  // Every single-word phrase across every project, measured once.
  const singles = [...new Set(projects.flatMap((p) => p.phrases).filter((p) => !p.includes(' ')))];
  const frequency = await wordFrequency(db, orgId, singles);
  const rareEnough = (word: string) => (frequency.get(word) ?? 0) <= Math.max(1, Math.floor(pile.length * RARE_ENOUGH));

  const openings = await readOpenings(db, orgId, pile.map((t) => t.id));
  const counts = await messageCounts(db, orgId, pile.map((t) => t.id));

  const suggestions: FilingSuggestion[] = [];
  let ambiguous = 0;

  for (const thread of pile) {
    const title = thread.title.toLowerCase();
    const body = (openings.get(thread.id) ?? '').toLowerCase();

    const hits = projects
      .map((project) => {
        const matched: string[] = [];
        let inTitle = false;
        for (const phrase of project.phrases) {
          const words = phrase.split(' ').length;
          // A one-word name is only a subject when it is in the title, and only
          // then if it is rare enough here to mean anything.
          if (words < PHRASE_TOKENS_TRUSTED) {
            if (mentions(title, phrase) && rareEnough(phrase)) {
              matched.push(phrase);
              inTitle = true;
            }
            continue;
          }
          // A multi-word name counts wherever it appears.
          if (mentions(title, phrase)) {
            matched.push(phrase);
            inTitle = true;
          } else if (mentions(body, phrase)) {
            matched.push(phrase);
          }
        }
        return {
          project,
          matched,
          inTitle,
          strength: Math.max(0, ...matched.map((m) => m.split(' ').length)) + (inTitle ? 1 : 0),
        };
      })
      .filter((h) => h.matched.length > 0);

    if (hits.length === 0) continue;

    // The longest phrase wins — "bespoke smith suite" beats a bare "smith".
    hits.sort((a, b) => b.strength - a.strength || b.matched.length - a.matched.length);
    const [best, runnerUp] = hits;
    if (!best) continue;
    // A tie is not a near-miss to be broken, it is a conversation about two
    // things. Left alone, and counted so the owner knows it exists.
    if (runnerUp && runnerUp.strength === best.strength && runnerUp.matched.length === best.matched.length) {
      ambiguous += 1;
      continue;
    }

    suggestions.push({
      threadId: thread.id,
      title: thread.title,
      at: thread.createdAt?.toISOString() ?? null,
      messageCount: counts.get(thread.id) ?? 0,
      projectId: best.project.projectId,
      projectName: best.project.name,
      because: best.matched,
      matchedIn: best.inTitle ? 'title' : 'text',
    });
    if (suggestions.length >= limit) break;
  }

  return { unfiled: pile.length, suggestions, ambiguous };
}

async function messageCounts(db: Db, orgId: string, threadIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (threadIds.length === 0) return out;
  const rows = await db
    .select({ threadId: agentMessages.threadId, n: sql<number>`count(*)::int` })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), inArray(agentMessages.threadId, threadIds)))
    .groupBy(agentMessages.threadId);
  for (const row of rows) if (row.threadId) out.set(row.threadId, Number(row.n));
  return out;
}
