import { and, asc, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { threads } from '../db/schema/index.js';
import { DEFAULT_AGENT, isAgentId, startingAgentFor, type AgentId } from '../../shared/agents.js';
import { DEFAULT_GENERAL_TITLE, DEFAULT_WORKSHOP_TITLE, type ThreadKind } from '../../shared/types/thread.js';

/**
 * The thread store — the one reader and writer of a project's conversations.
 * Org-scoped everywhere: a thread is fetched by (orgId, threadId), never by id
 * alone, so one org can never read into another's work.
 *
 * Phase 0 only needs two things of it: hand back the project's workshop thread
 * so every message and run written from here on names the conversation it
 * belongs to, and hold the shape the Inbox will list. Nothing above it changes
 * behavior yet — this is the seam, laid before the room is built on top of it.
 */

export type Thread = typeof threads.$inferSelect;

export type NewThreadFields = {
  kind: ThreadKind;
  title?: string;
  agent?: AgentId;
  model?: string | null;
};

export async function createThread(db: Db, orgId: string, projectId: string, fields: NewThreadFields): Promise<Thread> {
  const [row] = await db
    .insert(threads)
    .values({
      id: ulid(),
      orgId,
      projectId,
      kind: fields.kind,
      title: fields.title?.trim() || DEFAULT_WORKSHOP_TITLE,
      agent: fields.agent ?? startingAgentFor(fields.kind),
      model: fields.model ?? null,
    })
    .returning();
  return row!;
}

/**
 * A conversation about a SUBJECT rather than a project — no repo, no sandbox,
 * nothing to ship. Always `general`: there is nothing here for a builder to
 * build in, and offering one would be a lie about what this thread can do.
 */
export async function createSubjectThread(
  db: Db,
  orgId: string,
  subjectId: string,
  fields: { title?: string; agent?: AgentId; model?: string | null } = {},
): Promise<Thread> {
  const [row] = await db
    .insert(threads)
    .values({
      id: ulid(),
      orgId,
      projectId: null,
      subjectId,
      kind: 'general',
      title: fields.title?.trim() || DEFAULT_GENERAL_TITLE,
      agent: fields.agent ?? DEFAULT_AGENT,
      model: fields.model ?? null,
    })
    .returning();
  return row!;
}

export async function getThread(db: Db, orgId: string, threadId: string): Promise<Thread | null> {
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .limit(1);
  return row ?? null;
}

/** A project's threads, oldest first. Archived threads are excluded unless asked for. */
export async function listThreads(
  db: Db,
  orgId: string,
  projectId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<Thread[]> {
  return db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.orgId, orgId),
        eq(threads.projectId, projectId),
        includeArchived ? undefined : isNull(threads.archivedAt),
      ),
    )
    .orderBy(asc(threads.createdAt), asc(threads.id));
}

/**
 * The project's live workshop thread, created on first use.
 *
 * The oldest un-archived workshop thread wins, which is exactly the one
 * migration 0022 backfilled — so a project that has been worked on since before
 * threads existed keeps writing into its own history rather than starting a
 * second, empty conversation beside it.
 *
 * Concurrency: two simultaneous first-ever calls for the same project could
 * mint two threads. Left unguarded deliberately — the workshop already
 * serializes a project's turns (one run at a time), and a unique constraint
 * here would have to be dropped in Phase 1, where several workshop threads per
 * project is the whole point.
 */
export async function ensureWorkshopThread(db: Db, orgId: string, projectId: string, model?: string | null): Promise<Thread> {
  const [existing] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.orgId, orgId),
        eq(threads.projectId, projectId),
        eq(threads.kind, 'workshop'),
        isNull(threads.archivedAt),
      ),
    )
    .orderBy(asc(threads.createdAt), asc(threads.id))
    .limit(1);
  if (existing) return existing;
  return createThread(db, orgId, projectId, { kind: 'workshop', title: DEFAULT_WORKSHOP_TITLE, model: model ?? null });
}

/** Rename a thread. Returns false when there's no such thread for this org. */
/**
 * A CONVERSATION NAMED AFTER WHAT IS IN IT.
 *
 * Every workshop thread is created as "Workshop" and every idea as "New
 * thread", and nothing ever renamed them. That was invisible while the rail
 * showed only project names — and the moment the rail started showing what a
 * place IS, it showed twelve rows reading "Workshop", which is exactly as
 * useful as the blank line it replaced.
 *
 * So the first thing the owner says names the room. Their words, trimmed to a
 * line: "Give me a rundown of this app" beats "Workshop" at telling you which
 * of twelve this is, and it needs no model, no extra request, and no judgement
 * about what the conversation is "really" about.
 *
 * ONLY WHILE THE NAME IS STILL THE DEFAULT. A thread the owner renamed, or one
 * created with a real title, is never touched — this fills a blank, it does not
 * overwrite a decision. And only on the FIRST message, so a conversation does
 * not rename itself every time somebody types.
 */
export function titleFromFirstMessage(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return '';
  // A sentence's worth. Cut on a word boundary rather than mid-word, and drop
  // trailing punctuation so a title never ends in a comma.
  if (line.length <= TITLE_CHARS) return line.replace(/[\s,;:.\-—]+$/, '');
  const cut = line.slice(0, TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > TITLE_CHARS / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.\-—]+$/, '') + '…';
}

/** Long enough to be a sentence, short enough for a rail row. */
const TITLE_CHARS = 60;

/** True when nobody has named this conversation — see titleFromFirstMessage. */
export function isDefaultTitle(title: string): boolean {
  const t = title.trim();
  return t === DEFAULT_WORKSHOP_TITLE || t === DEFAULT_GENERAL_TITLE || t === '';
}

export async function renameThread(db: Db, orgId: string, threadId: string, title: string): Promise<boolean> {
  const trimmed = title.trim();
  if (trimmed === '') return false;
  const rows = await db
    .update(threads)
    .set({ title: trimmed.slice(0, 120) })
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .returning({ id: threads.id });
  return rows.length > 0;
}

/**
 * MOVE A CONVERSATION INTO A PROJECT — or back out of one.
 *
 * The operation the product did not have, and the reason an import was a
 * dead end: conversations arrived filed under a per-vendor subject and there
 * was no way to put one anywhere else, ever. "Bring your history and continue
 * building" was true up to the word "continue".
 *
 * A project and a subject are the two places a conversation can live and it
 * lives in exactly one, so filing into a project clears the subject and taking
 * it back out restores one. Passing `null` for both would leave a thread
 * nowhere — visible in no list, findable only by search — so the caller has to
 * name the subject it goes home to.
 *
 * WHAT THIS NEVER TOUCHES: `imported_from` and `import_source_id`. Where a
 * conversation came from is a fact about the conversation, not about where it
 * is filed, and the mark on an imported thread — "nothing in it was said to
 * Selvedge" — has to survive being put somewhere useful. Filing it into a
 * project must not launder it into something that was.
 */
export async function fileThread(
  db: Db,
  orgId: string,
  threadId: string,
  destination: { projectId: string } | { subjectId: string },
): Promise<boolean> {
  const set =
    'projectId' in destination
      ? { projectId: destination.projectId, subjectId: null }
      : { projectId: null, subjectId: destination.subjectId };
  const rows = await db
    .update(threads)
    .set(set)
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .returning({ id: threads.id });
  return rows.length > 0;
}

/** Archive or restore a thread. Threads are archived, never deleted — the record is the product. */
export async function setThreadArchived(db: Db, orgId: string, threadId: string, archived: boolean): Promise<boolean> {
  const rows = await db
    .update(threads)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .returning({ id: threads.id });
  return rows.length > 0;
}

/**
 * Point a thread at a different agent. Records only who answers NEXT — the
 * switch itself belongs on the thread, where it can carry what the handoff
 * actually cost. Refuses an agent id the registry doesn't know, and an agent
 * that can't run this kind of thread.
 */
export async function setThreadAgent(
  db: Db,
  orgId: string,
  threadId: string,
  agent: string,
  model?: string | null,
): Promise<{ ok: true; thread: Thread } | { ok: false; reason: 'no_such_thread' | 'unknown_agent' }> {
  if (!isAgentId(agent)) return { ok: false, reason: 'unknown_agent' };
  const thread = await getThread(db, orgId, threadId);
  if (!thread) return { ok: false, reason: 'no_such_thread' };
  // No capability gate here: any agent may answer in any conversation. What
  // differs is what happens when it does, which the message path decides.
  const [row] = await db
    .update(threads)
    .set({ agent, ...(model === undefined ? {} : { model }) })
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .returning();
  return { ok: true, thread: row! };
}
