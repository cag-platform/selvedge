import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, threads } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import { listSubjects } from '../threads/subjects.js';
import { contextForProject } from '../companion/context.js';
import { referencedNames } from '../../shared/references.js';
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

/** Turns of a referenced conversation to carry. Enough for the gist, not the transcript. */
const MAX_TURNS = 12;
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
): Promise<ResolvedReference> {
  const rows = await db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, thread.id)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(MAX_TURNS);

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
