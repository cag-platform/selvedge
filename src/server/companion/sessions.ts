import { and, desc, eq, gte } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { externalSessions } from '../db/schema/index.js';
import { listPacks } from '../packs/store.js';
import type { SessionSummary } from '../../shared/types/session.js';

/**
 * Sessions Selvedge didn't run, joining the record.
 *
 * The honesty rule that governs everything here: these are OBSERVED, not
 * performed. Selvedge did not gate this work, did not verify it, and cannot
 * vouch for it — it heard about it afterwards from a program watching a log.
 * Every surface that shows one says so, and nothing here may ever produce a
 * verdict.
 */

export type ExternalSession = typeof externalSessions.$inferSelect;

/** A repo string, however it was written, reduced to owner/name for comparison. */
function normalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Which project did this session happen in?
 *
 * By the repo first — that is a fact, and it is what the brief specifies. By
 * the working directory's name second, which is a guess, and only when it
 * matches a project id or the tail of a known repo exactly. Anything less
 * certain resolves to null: a session filed under the wrong project is worse
 * than one filed under none, because the wrong one quietly poisons that
 * project's history.
 */
export async function resolveProjectForSession(
  db: Db,
  orgId: string,
  where: { repo?: string | undefined; cwd?: string | undefined },
): Promise<string | null> {
  const packs = await listPacks(db, orgId);
  if (where.repo) {
    const wanted = normalizeRepo(where.repo);
    for (const pack of packs) {
      for (const source of pack.topology.sources) {
        if (source.connector === 'github' && normalizeRepo(source.resource_id) === wanted) return pack.identity.project_id;
      }
    }
  }
  const folder = where.cwd?.replace(/\/+$/, '').split('/').pop()?.toLowerCase();
  if (folder) {
    for (const pack of packs) {
      if (pack.identity.project_id.toLowerCase() === folder) return pack.identity.project_id;
      for (const source of pack.topology.sources) {
        if (source.connector === 'github' && normalizeRepo(source.resource_id).split('/').pop() === folder) return pack.identity.project_id;
      }
    }
  }
  return null;
}

/**
 * Store one session summary. Keyed on (org, agent, session id), so the
 * companion can re-send the same session — after a restart, or because it
 * learned the commit later — without ever producing a second row for one
 * session.
 */
export async function recordSession(db: Db, orgId: string, summary: SessionSummary): Promise<{ projectId: string | null }> {
  const projectId = await resolveProjectForSession(db, orgId, { repo: summary.repo, cwd: summary.cwd });
  const values = {
    orgId,
    projectId,
    agent: summary.agent,
    sessionId: summary.session_id,
    repo: summary.repo ?? null,
    cwd: summary.cwd ?? null,
    intent: summary.intent ?? null,
    filesTouched: summary.files_touched ?? null,
    toolsRun: summary.tools_run ?? null,
    outcome: summary.outcome,
    commitSha: summary.commit_sha ?? null,
    costUsd: summary.cost_usd ?? null,
    detail: summary.detail ?? null,
    startedAt: summary.started_at ? new Date(summary.started_at) : null,
    endedAt: summary.ended_at ? new Date(summary.ended_at) : null,
  };
  await db
    .insert(externalSessions)
    .values({ id: ulid(), ...values })
    .onConflictDoUpdate({
      target: [externalSessions.orgId, externalSessions.agent, externalSessions.sessionId],
      set: values,
    });
  return { projectId };
}

export async function listExternalSessions(
  db: Db,
  orgId: string,
  { projectId, since, limit = 100 }: { projectId?: string; since?: Date; limit?: number } = {},
): Promise<ExternalSession[]> {
  const filters = [eq(externalSessions.orgId, orgId)];
  if (projectId) filters.push(eq(externalSessions.projectId, projectId));
  if (since) filters.push(gte(externalSessions.createdAt, since));
  return db
    .select()
    .from(externalSessions)
    .where(and(...filters))
    .orderBy(desc(externalSessions.createdAt))
    .limit(limit);
}
