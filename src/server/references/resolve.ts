import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, threads } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import { listSubjects } from '../threads/subjects.js';
import { contextForProject } from '../companion/context.js';
import { referencedNames } from '../../shared/references.js';
import { AGENTS } from '../../shared/agents.js';
import { VENDOR_NAMES } from '../import/consumer/types.js';

/**
 * WHAT A #NAME MEANS, AND WHAT IT IS ALLOWED TO SAY.
 *
 * Three kinds of thing can be pointed at, and the difference between them is
 * what each can honestly offer:
 *
 *   a project      → its context pack: what it is, what changed, what's open.
 *                    Grounded in what actually happened to the code.
 *   a subject      → the conversations filed under it.
 *   a conversation → its own turns, including one imported from ChatGPT,
 *                    Claude or Gemini.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD.
 *
 * Everything is scoped to one org before a single row is read. A reference is
 * a way to pull somebody's data into a model call, which makes it exactly the
 * wrong place to be relaxed about whose data it is.
 *
 * An imported conversation says so, every time it is used. What you told
 * ChatGPT in March is worth knowing and is NOT the same as something decided
 * here; a reference that quietly turns the first into the second would be the
 * false-calm rule wearing a different coat. The mark rides on the rendered
 * block AND on the line the owner sees.
 */

/**
 * Turns of a referenced conversation to carry.
 *
 * Raised from twelve, which was a number I picked rather than justified. The
 * point of pointing at another conversation is to keep its memory in place
 * while you work somewhere else, and half a conversation is a worse kind of
 * memory than none — it reads as complete while missing what was decided.
 */
const MAX_TURNS = 30;
/** A conversation the DATABASE found rather than one you named — shallower, because it is a guess. */
const MAX_FOUND_TURNS = 10;
/** A single message is clipped to this before it goes anywhere near a prompt. */
const MAX_MESSAGE_CHARS = 700;
/** Threads listed under a referenced subject. */
const MAX_SUBJECT_THREADS = 5;

export type ReferenceKind = 'project' | 'subject' | 'conversation';

export type ResolvedReference = {
  kind: ReferenceKind;
  id: string;
  /** What the owner called it — used in the line the conversation records. */
  label: string;
  /**
   * True when the database found this from what was asked rather than the
   * owner naming it. Said out loud, because a guess presented as a choice is
   * how somebody ends up thinking they pointed at something they didn't.
   */
  found?: boolean;
  /** "imported from ChatGPT", where that is true. Undefined otherwise. */
  note?: string;
  /** The block handed to the model. */
  text: string;
};

/** A name that matched nothing, kept so the answer can say so rather than inventing. */
export type UnresolvedReference = { name: string };

export type ReferenceResult = {
  resolved: ResolvedReference[];
  missed: UnresolvedReference[];
};

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Loose enough to forgive punctuation and case, exact enough not to guess.
 * `#peas-bees` finding "Peas&Bees Co Garden Shop" is helpful; `#loom` finding
 * "Bloomberg" is not, so this is prefix-or-equal on the normalised form rather
 * than a substring search anywhere in the title.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matches(name: string, candidate: string): boolean {
  const a = normalise(name);
  const b = normalise(candidate);
  if (a === '' || b === '') return false;
  return b === a || b.startsWith(a);
}

/** How a thread should be described when it is pointed at. */
function threadNote(row: { importedFrom: string | null }): string | undefined {
  if (!row.importedFrom) return undefined;
  const vendor = VENDOR_NAMES[row.importedFrom as keyof typeof VENDOR_NAMES] ?? row.importedFrom;
  return `imported from ${vendor}`;
}

async function renderConversation(
  db: Db,
  orgId: string,
  thread: { id: string; title: string; importedFrom: string | null },
  { found = false }: { found?: boolean } = {},
): Promise<ResolvedReference> {
  const rows = await db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(found ? MAX_FOUND_TURNS : MAX_TURNS);

  const said = rows
    .reverse()
    .filter((m) => m.role === 'owner' || m.role === 'agent')
    .map((m) => `${m.role === 'owner' ? 'Owner' : 'Assistant'}: ${clip(m.content, MAX_MESSAGE_CHARS)}`);

  const note = threadNote(thread);
  const heading = note
    ? // Stated as a fact about the source, so a model reading this cannot
      // mistake it for something the owner settled inside Selvedge.
      `Another conversation the owner had, "${thread.title}" — ${note}, not said to Selvedge. Treat it as what they were thinking there, not as a decision made here.`
    : `Another conversation in this account, "${thread.title}".`;

  return {
    kind: 'conversation',
    id: thread.id,
    label: thread.title,
    ...(found ? { found: true } : {}),
    ...(note ? { note } : {}),
    text: [
      heading,
      said.length ? said.join('\n\n') : 'Nothing was said in it.',
      // The same rule the pack context ends on: a gap is not evidence of
      // simplicity.
      'Only the most recent part of it is here. Where it is silent, that means it was not carried, not that it did not happen.',
    ].join('\n\n'),
  };
}

/**
 * Resolve every #name in a message against this org, in the order they were
 * written. Names that match nothing come back in `missed` rather than being
 * dropped — an answer that silently ignores half of what was asked about is
 * worse than one that says "I don't have anything called that".
 */
export async function resolveReferences(db: Db, orgId: string, text: string): Promise<ReferenceResult> {
  const names = referencedNames(text);
  if (names.length === 0) return { resolved: [], missed: [] };

  const [packs, subjectRows, threadRows] = await Promise.all([
    listPacks(db, orgId),
    listSubjects(db, orgId),
    db
      .select({ id: threads.id, title: threads.title, importedFrom: threads.importedFrom, projectId: threads.projectId, subjectId: threads.subjectId })
      .from(threads)
      .where(and(eq(threads.orgId, orgId), isNull(threads.archivedAt))),
  ]);

  const resolved: ResolvedReference[] = [];
  const missed: UnresolvedReference[] = [];

  for (const name of names) {
    // A PROJECT FIRST. It is the most grounded thing a name can mean — the
    // pack is built from what happened rather than from what was said — and
    // its own conversation is reachable from it anyway.
    const pack = packs.find((p) => matches(name, p.identity.name) || matches(name, p.identity.project_id));
    if (pack) {
      const context = await contextForProject(db, orgId, pack.identity.project_id);
      if (context) {
        resolved.push({ kind: 'project', id: pack.identity.project_id, label: pack.identity.name, text: context.text });
        continue;
      }
    }

    const subject = subjectRows.find((s) => matches(name, s.name));
    if (subject) {
      const under = threadRows.filter((t) => t.subjectId === subject.id).slice(0, MAX_SUBJECT_THREADS);
      resolved.push({
        kind: 'subject',
        id: subject.id,
        label: subject.name,
        text: [
          `"${subject.name}" is somewhere the owner keeps work that isn't a codebase.`,
          under.length
            ? ['Conversations filed under it:', ...under.map((t) => `- ${t.title}${threadNote(t) ? ` (${threadNote(t)})` : ''}`)].join('\n')
            : 'Nothing has been filed under it yet.',
        ].join('\n\n'),
      });
      continue;
    }

    const thread = threadRows.find((t) => matches(name, t.title));
    if (thread) {
      resolved.push(await renderConversation(db, orgId, thread));
      continue;
    }

    missed.push({ name });
  }

  return { resolved, missed };
}

/**
 * The referenced material as it goes in front of the question — each block
 * fenced by what it is, so a model can tell the thing being asked about from
 * the thing being asked.
 */
export function renderReferences(result: ReferenceResult): string | null {
  if (result.resolved.length === 0 && result.missed.length === 0) return null;
  const parts = result.resolved.map((r) => `--- ${r.label}${r.note ? ` (${r.note})` : ''} ---\n${r.text}`);
  if (result.missed.length > 0) {
    // Said out loud rather than dropped: the owner asked about something, and
    // "I don't have anything by that name" is an answer. Guessing is not.
    parts.push(
      `The owner also mentioned ${result.missed
        .map((m) => `"${m.name}"`)
        .join(', ')}, which is nothing in this account. Say so plainly rather than guessing what they meant.`,
    );
  }
  return `Other things the owner pointed at, for context. None of this is what they are asking you to change.\n\n${parts.join('\n\n')}`;
}

/** One thing that can be pointed at, for the composer's picker. */
export type ReferenceCandidate = {
  kind: ReferenceKind;
  id: string;
  name: string;
  /** "imported from ChatGPT", where that is true. */
  note?: string;
};

/**
 * Everything this org can point at, for the `#` picker.
 *
 * Projects first because they are the most grounded thing a name can mean,
 * then subjects, then conversations. Imported ones are listed like any other
 * and carry their mark — the whole reason the import exists is so a chat you
 * had elsewhere is reachable here, and a picker that hid them would undo it.
 */
export async function listReferenceCandidates(db: Db, orgId: string): Promise<ReferenceCandidate[]> {
  const [packs, subjectRows, threadRows] = await Promise.all([
    listPacks(db, orgId),
    listSubjects(db, orgId),
    db
      .select({ id: threads.id, title: threads.title, importedFrom: threads.importedFrom })
      .from(threads)
      .where(and(eq(threads.orgId, orgId), isNull(threads.archivedAt))),
  ]);

  return [
    ...packs.map((p) => ({ kind: 'project' as const, id: p.identity.project_id, name: p.identity.name })),
    ...subjectRows.map((s) => ({ kind: 'subject' as const, id: s.id, name: s.name })),
    ...threadRows.map((t) => {
      const note = threadNote(t);
      return { kind: 'conversation' as const, id: t.id, name: t.title, ...(note ? { note } : {}) };
    }),
  ];
}

/**
 * FINDING WHAT THEY MEANT WITHOUT BEING TOLD.
 *
 * `#loom` is exact and free, and it stays. But nobody types punctuation when
 * they are thinking — "refer to our chats about moving to a monthly fee" is
 * how the question actually arrives, and answering it with "no such thing as
 * that" while the conversation sits in the database is the product being
 * pedantic at somebody who is right.
 *
 * THE DATABASE DOES THE FINDING, not a model. Postgres full-text over the
 * owner's own messages, ranked, top few. That matters for scale in a way a
 * model-picks-from-a-list design does not: the cost of this is one query
 * whatever the size of the history, whereas listing every conversation's title
 * in a prompt gets more expensive with every conversation you have — the
 * accounts that most need to reach backwards being exactly the ones it would
 * punish.
 *
 * What keeps it honest: nothing found is nothing added, everything found is
 * SAID on the thread and marked as found rather than chosen, and an explicit
 * `#` skips this entirely — you named it, there is nothing to guess.
 */

/**
 * TWO WORDS IN COMMON IS NOT A SUBJECT IF BOTH WORDS ARE "MAKE" AND "BETTER".
 *
 * This started as a flat "two distinct terms matched" and it was too loose by a
 * long way. The message that proved it was "@claude give me your thoughts on
 * what could make this better as well", sent in a thread about a chess app,
 * which came back having "looked back at" three imported conversations about
 * venture pitches and cross-border communications. Nothing in that sentence is
 * about anything, and the product said it had found what the owner meant.
 *
 * Two separate faults, both fixed below:
 *
 *  1. THE AGENT'S NAME WAS A SEARCH TERM. `@claude` survived into the query, and
 *     conversations imported from Claude tend to contain the word "Claude" — so
 *     naming who should answer silently searched for everything that agent had
 *     ever said. Choosing who answers is ROUTING; it is never subject matter.
 *
 *  2. FILLER COUNTED AS SIGNAL. Postgres drops true stopwords ("the", "what",
 *     "could"), which the old code relied on — but "give", "thoughts", "make",
 *     "better" and "well" are not stopwords to Postgres and are not about
 *     anything to a person. A sentence made only of those has no subject, and
 *     the honest number of related conversations to find in it is zero.
 *
 * So the bar is now proportional to how much the message actually says. Counted
 * rather than scored, still: `ts_rank` normalises by query length, so a precise
 * twelve-word question would rank below a vague three-word one.
 */
const MIN_TERMS_MATCHED = 2;
/**
 * A long question should not be satisfied by two words, and should not need ten
 * either. Half the subject terms, never fewer than two, never more than four.
 */
const MAX_TERMS_REQUIRED = 4;
/** How many the database may bring on its own. Deliberately fewer than you may name. */
const MAX_FOUND = 3;
/** Too short to be about anything: "yes", "do it", "make it darker". */
const MIN_QUERY_CHARS = 12;

/**
 * Words that are common in ASKING and absent from SUBJECTS. Two kinds, and
 * both have to go for the same reason.
 *
 * GRAMMAR. Postgres's english dictionary already scores these zero, so they
 * were harmless to the numerator — but they were counted in the DENOMINATOR
 * when working out how many terms a match should cover, which made a wordy
 * question demand more matches than it contained matchable words. Dropping them
 * here makes the proportion honest and the generated SQL smaller.
 *
 * FILLER. What Postgres keeps and a person would not call subject matter:
 * think, better, thoughts, want, help. A conversation matching on those is
 * matching on the fact that it too was a conversation.
 *
 * The filler half is deliberately conservative — meta-vocabulary, not weak
 * nouns. "Work", "add" and "use" are NOT here: they are vague, but a person
 * really can be looking for the chat where they worked something out. An owner
 * who wants a past conversation about any word in this list can still name it
 * with `#`, which skips this search entirely.
 */
const NO_SUBJECT = new Set([
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

export async function findRelatedConversations(
  db: Db,
  orgId: string,
  text: string,
  { excludeThreadId, limit = MAX_FOUND }: { excludeThreadId?: string; limit?: number } = {},
): Promise<ResolvedReference[]> {
  const query = text
    // An explicit `#reference` is handled elsewhere, and an `@mention` decides
    // who answers. Neither is something to search for.
    .replace(/#"[^"]*"|#[A-Za-z0-9_-]+/g, ' ')
    .replace(/(^|[^A-Za-z0-9_])@[A-Za-z0-9_-]+/g, '$1 ')
    .trim();
  if (query.length < MIN_QUERY_CHARS) return [];

  /**
   * OR, NOT AND. `websearch_to_tsquery` joins every word with AND, so a
   * question phrased as a question — "refer to our chats about the move to a
   * monthly fee" — can only match a message containing all eleven words, which
   * is to say never. Terms are OR'd instead and the RANK does the work: a
   * message matching four of them outranks one matching two, and the floor
   * above drops the ones matching one.
   *
   * Terms are reduced to letters and digits before they reach `to_tsquery`,
   * which takes an expression rather than a phrase and would otherwise choke on
   * an apostrophe or a bracket.
   */
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((t) => !NO_SUBJECT.has(t)).slice(0, 24);
  // Fewer than two words that are about anything means the message is about
  // nothing findable — which is the correct answer for "give me your thoughts
  // on what could make this better", and was previously three confident and
  // unrelated conversations.
  if (terms.length < MIN_TERMS_MATCHED) return [];
  const expression = terms.join(' | ');
  const required = Math.min(MAX_TERMS_REQUIRED, Math.max(MIN_TERMS_MATCHED, Math.ceil(terms.length / 2)));

  // How many of the terms one message covers. Stopwords contribute nothing on
  // their own — `to_tsquery('english', 'the')` is an empty query and matches
  // nothing — so "our chats about the…" costs three terms and scores zero.
  const covered = sql.join(
    terms.map((t) => sql`(case when to_tsvector('english', ${agentMessages.content}) @@ to_tsquery('english', ${t}) then 1 else 0 end)`),
    sql` + `,
  );
  // Per THREAD, the best single message: one that covers four of the terms is
  // about the subject, where four messages covering one each are not.
  const best = sql<number>`max(${covered})`;

  let rows: Array<{ id: string; title: string; importedFrom: string | null; matched: number }>;
  try {
    rows = await db
      .select({ id: threads.id, title: threads.title, importedFrom: threads.importedFrom, matched: best })
      .from(agentMessages)
      .innerJoin(threads, eq(threads.id, agentMessages.threadId))
      .where(
        and(
          eq(agentMessages.orgId, orgId),
          isNull(threads.archivedAt),
          excludeThreadId ? sql`${threads.id} <> ${excludeThreadId}` : undefined,
          sql`to_tsvector('english', ${agentMessages.content}) @@ to_tsquery('english', ${expression})`,
        ),
      )
      .groupBy(threads.id, threads.title, threads.importedFrom)
      .having(sql`${best} >= ${required}`)
      .orderBy(desc(best))
      .limit(limit);
  } catch {
    // A search that cannot run is not a turn that cannot happen.
    return [];
  }

  return Promise.all(rows.map((r) => renderConversation(db, orgId, r, { found: true })));
}
