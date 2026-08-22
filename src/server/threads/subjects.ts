import { and, asc, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { subjects, threads } from '../db/schema/index.js';

/**
 * The subject store. Deliberately the smallest store in the codebase: a subject
 * is a name with conversations under it, and there is nothing else to keep.
 *
 * What a subject deliberately does NOT have: stakes, topology, health, a
 * timeline, a verdict, an edge colour. Nothing about it is watched, so nothing
 * about it may look watched — a subject that showed a status would be claiming
 * to know something about a thing there is nothing to know about.
 */

export type Subject = typeof subjects.$inferSelect;

export async function createSubject(db: Db, orgId: string, name: string, description?: string): Promise<Subject> {
  const [row] = await db
    .insert(subjects)
    .values({
      id: ulid(),
      orgId,
      name: name.trim().slice(0, 120) || 'Untitled',
      description: description?.trim().slice(0, 500) || null,
    })
    .returning();
  return row!;
}

/**
 * The subject of a given name, made if it isn't there yet.
 *
 * Exists for the history import, which files an account's old conversations
 * somewhere they can be SEEN. A thread belonging to neither a project nor a
 * subject is filed nowhere and the rail cannot show it — reachable by name and
 * findable by nobody, which is a worse state than being in the wrong place.
 */
export async function ensureSubject(db: Db, orgId: string, name: string, description?: string): Promise<Subject> {
  const wanted = name.trim().slice(0, 120) || 'Untitled';
  const existing = await listSubjects(db, orgId, { includeArchived: true });
  const already = existing.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (already) return already;
  return createSubject(db, orgId, wanted, description);
}

export async function getSubject(db: Db, orgId: string, id: string): Promise<Subject | null> {
  const [row] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.orgId, orgId), eq(subjects.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listSubjects(db: Db, orgId: string, { includeArchived = false } = {}): Promise<Subject[]> {
  return db
    .select()
    .from(subjects)
    .where(and(eq(subjects.orgId, orgId), includeArchived ? undefined : isNull(subjects.archivedAt)))
    .orderBy(asc(subjects.name), asc(subjects.id));
}

export async function renameSubject(db: Db, orgId: string, id: string, name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === '') return false;
  const rows = await db
    .update(subjects)
    .set({ name: trimmed.slice(0, 120) })
    .where(and(eq(subjects.orgId, orgId), eq(subjects.id, id)))
    .returning({ id: subjects.id });
  return rows.length > 0;
}

/**
 * Archive a subject. The threads under it are NOT touched: they are the record,
 * and a subject is only the folder they were in.
 */
export async function setSubjectArchived(db: Db, orgId: string, id: string, archived: boolean): Promise<boolean> {
  const rows = await db
    .update(subjects)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(subjects.orgId, orgId), eq(subjects.id, id)))
    .returning({ id: subjects.id });
  return rows.length > 0;
}

/** A subject's conversations, oldest first — the same order a project's threads keep. */
export async function threadsForSubject(db: Db, orgId: string, subjectId: string) {
  return db
    .select()
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.subjectId, subjectId), isNull(threads.archivedAt)))
    .orderBy(asc(threads.createdAt), asc(threads.id));
}
