import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { agentMessages, threads } from '../../db/schema/index.js';
import { defaultAgentFor } from '../../../shared/agents.js';
import { VENDOR_NAMES, type ImportedConversation, type Vendor } from './types.js';

/**
 * FILING OLD CHATS.
 *
 * An imported conversation becomes an ordinary general thread: it lists in the
 * rail, it searches, it is part of the project's or the subject's history —
 * which is the entire point of importing it. What it must never become is
 * indistinguishable from something said to Selvedge. Two things keep that
 * straight, permanently:
 *
 * 1. `imported_from` / `import_source_id` on the thread row, so provenance is
 *    structure rather than prose someone could edit away.
 * 2. A switch line at the top of every imported thread saying where it came
 *    from and that nothing in it was said here.
 *
 * DATES. Where the export gave a time we use it. Where it did not, the message
 * is stamped one second after the one before it — an ordering, not a claim —
 * and the message carries `meta.imported.dated = false` so nothing downstream
 * can present that stamp as when it was actually said.
 */

export type Target = { projectId: string; subjectId?: undefined } | { subjectId: string; projectId?: undefined };

export type FileResult = {
  filed: number;
  /** Already imported from this vendor in a previous run — not re-filed, not duplicated. */
  alreadyHad: number;
  threadIds: string[];
};

function provenanceLine(vendor: Vendor, convo: ImportedConversation): string {
  const when = convo.startedAt ? new Date(convo.startedAt).toISOString().slice(0, 10) : 'an unrecorded date';
  const count = convo.messages.length;
  return `⇄ imported from ${VENDOR_NAMES[vendor]} — ${count} message${count === 1 ? '' : 's'}, ${when}. Nothing in it was said to Selvedge.`;
}

export async function fileConversations(
  db: Db,
  orgId: string,
  target: Target,
  vendor: Vendor,
  conversations: ImportedConversation[],
): Promise<FileResult> {
  if (conversations.length === 0) return { filed: 0, alreadyHad: 0, threadIds: [] };

  // What this org already holds from this vendor, so a second import of the
  // same export is a no-op rather than a doubling. The unique index is the
  // real guarantee; this is what lets us report the number honestly.
  const ids = conversations.map((c) => c.sourceId);
  const existing = await db
    .select({ sourceId: threads.importSourceId })
    .from(threads)
    .where(
      and(
        eq(threads.orgId, orgId),
        eq(threads.importedFrom, vendor),
        isNotNull(threads.importSourceId),
        inArray(threads.importSourceId, ids),
      ),
    );
  const had = new Set(existing.map((r) => r.sourceId));

  const threadIds: string[] = [];
  for (const convo of conversations) {
    if (had.has(convo.sourceId)) continue;
    const threadId = ulid();
    const startedAt = convo.startedAt ? new Date(convo.startedAt) : new Date();

    await db.insert(threads).values({
      id: threadId,
      orgId,
      projectId: target.projectId ?? null,
      subjectId: target.subjectId ?? null,
      kind: 'general',
      title: convo.title,
      // Whoever answers NEXT in this thread is Selvedge's own chat agent. The
      // thread's history is somebody else's; its future is not.
      agent: defaultAgentFor('general'),
      createdAt: startedAt,
      importedFrom: vendor,
      importSourceId: convo.sourceId,
    });

    const rows: Array<typeof agentMessages.$inferInsert> = [
      {
        id: ulid(),
        orgId,
        projectId: target.projectId ?? null,
        threadId,
        role: 'switch',
        content: provenanceLine(vendor, convo),
        createdAt: startedAt,
        meta: { imported: { vendor, source_id: convo.sourceId } },
      },
    ];

    let clock = startedAt.getTime();
    for (const message of convo.messages) {
      const stated = message.at ? new Date(message.at).getTime() : null;
      const dated = stated !== null && Number.isFinite(stated);
      // Monotonic either way: an export with times that go backwards must not
      // scramble the order of a conversation a person will read.
      clock = dated ? Math.max(stated, clock + 1) : clock + 1000;
      rows.push({
        id: ulid(),
        orgId,
        projectId: target.projectId ?? null,
        threadId,
        role: message.role,
        content: message.content,
        createdAt: new Date(clock),
        meta: { imported: { vendor, dated } },
      });
    }

    await db.insert(agentMessages).values(rows);
    threadIds.push(threadId);
  }

  return { filed: threadIds.length, alreadyHad: conversations.length - threadIds.length, threadIds };
}
