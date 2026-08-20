import { and, asc, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { threads } from '../db/schema/index.js';
import { agentById, defaultAgentFor, isAgentId, type AgentId } from '../../shared/agents.js';
import { DEFAULT_WORKSHOP_TITLE, type ThreadKind } from '../../shared/types/thread.js';

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
      agent: fields.agent ?? defaultAgentFor(fields.kind),
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
): Promise<{ ok: true; thread: Thread } | { ok: false; reason: 'no_such_thread' | 'unknown_agent' | 'wrong_kind' }> {
  if (!isAgentId(agent)) return { ok: false, reason: 'unknown_agent' };
  const thread = await getThread(db, orgId, threadId);
  if (!thread) return { ok: false, reason: 'no_such_thread' };
  const descriptor = agentById(agent)!;
  if (!descriptor.kinds.includes(thread.kind as ThreadKind)) return { ok: false, reason: 'wrong_kind' };
  const [row] = await db
    .update(threads)
    .set({ agent, ...(model === undefined ? {} : { model }) })
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)))
    .returning();
  return { ok: true, thread: row! };
}
