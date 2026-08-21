import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, events, externalSessions, threads } from '../db/schema/index.js';
import { agentById } from '../../shared/agents.js';
import type { ChangeRefs } from '../../shared/types/event.js';
import { composeFusion, type Fusion, type SessionAttribution } from './attribute.js';

/**
 * FROM A CHANGE TO THE WORK BEHIND IT.
 *
 * Three ways a commit can name its session, in descending order of certainty:
 *
 *  1. THE TRAILER. `Selvedge-Session: <thread id>`, written into the commit by
 *     Selvedge's own ship (Phase 0). This is not an inference — the commit says
 *     so itself, in the repo, and it survives rebases, mirrors, and Selvedge.
 *  2. THE RUN ROW. A ship Selvedge performed records the sha it pushed. Same
 *     conclusion by a second road; belt and braces for commits stamped before
 *     the trailer existed, or whose message was rewritten.
 *  3. THE COMPANION'S MAPPING. A session observed in someone's terminal that had
 *     a commit land while it was open. Weaker by construction — "this session
 *     was open when this commit appeared" — and marked as observed everywhere
 *     it is shown.
 *
 * What is NOT here: a time-window guess. If no commit names a session, there is
 * no attribution, and the brief says only what correlation already knew.
 */

/** The change refs a stored event carries, or nothing. */
export async function changeRefsFor(db: Db, orgId: string, eventId: string): Promise<ChangeRefs | null> {
  const [row] = await db
    .select({ changeRefs: events.changeRefs })
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.id, eventId)))
    .limit(1);
  const refs = row?.changeRefs as ChangeRefs | null | undefined;
  if (!refs || (!refs.commits?.length && !refs.sessions?.length)) return null;
  return { commits: refs.commits ?? [], sessions: refs.sessions ?? [] };
}

/** Every session a change's commits can be traced to, deduplicated. */
export async function attributionsFor(db: Db, orgId: string, refs: ChangeRefs): Promise<SessionAttribution[]> {
  const found = new Map<string, SessionAttribution>();

  // 1. The trailer — the commit naming its own conversation.
  if (refs.sessions.length) {
    const rows = await db
      .select()
      .from(threads)
      .where(and(eq(threads.orgId, orgId), inArray(threads.id, refs.sessions)));
    for (const thread of rows) {
      found.set(`thread:${thread.id}`, {
        kind: 'selvedge',
        threadId: thread.id,
        title: thread.title,
        agent: thread.agent,
        at: thread.createdAt.toISOString(),
        commit: null,
      });
    }
  }

  if (refs.commits.length) {
    // 2. A ship Selvedge performed, matched by the sha it pushed.
    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), isNotNull(agentRuns.commitSha), inArray(agentRuns.commitSha, refs.commits)));
    for (const run of runs) {
      if (!run.threadId) continue;
      const key = `thread:${run.threadId}`;
      if (found.has(key)) {
        // Already known from the trailer; keep it, but record which commit it was.
        const existing = found.get(key)!;
        found.set(key, { ...existing, commit: run.commitSha });
        continue;
      }
      const [thread] = await db.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.id, run.threadId))).limit(1);
      if (!thread) continue;
      found.set(key, {
        kind: 'selvedge',
        threadId: thread.id,
        title: thread.title,
        agent: run.agent ?? thread.agent,
        at: run.createdAt.toISOString(),
        commit: run.commitSha,
      });
    }

    // 3. A session the companion watched, which had this commit land while it was open.
    const sessions = await db
      .select()
      .from(externalSessions)
      .where(and(eq(externalSessions.orgId, orgId), isNotNull(externalSessions.commitSha), inArray(externalSessions.commitSha, refs.commits)));
    for (const session of sessions) {
      found.set(`session:${session.id}`, {
        kind: 'observed',
        sessionId: session.sessionId,
        agent: session.agent,
        intent: session.intent,
        at: (session.endedAt ?? session.startedAt ?? session.createdAt).toISOString(),
        commit: session.commitSha,
      });
    }
  }

  // Newest first: when the sentence has to name several, it names the most
  // recent ones, which are the ones worth reading first.
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The whole join: a correlated change event in, a sentence out — or null, which
 * is the honest and common answer.
 */
export async function fusionForChange(
  db: Db,
  orgId: string,
  changeEventId: string,
  breakAt: Date,
): Promise<Fusion | null> {
  const refs = await changeRefsFor(db, orgId, changeEventId);
  if (!refs) return null;
  const attributions = await attributionsFor(db, orgId, refs);
  return composeFusion(attributions, breakAt, (id) => agentById(id)?.name ?? id);
}
