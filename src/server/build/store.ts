import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projectBuild } from '../db/schema/index.js';

/**
 * The build-state store — the one reader/writer of a project's workshop state
 * (its sandbox id, agent session, preview, staged-changes flag). Org-scoped
 * everywhere; a project's build state is fetched by (orgId, projectId) so one
 * org can never touch another's sandbox.
 */

export type BuildState = typeof projectBuild.$inferSelect;

export async function getBuild(db: Db, orgId: string, projectId: string): Promise<BuildState | null> {
  const [row] = await db
    .select()
    .from(projectBuild)
    .where(and(eq(projectBuild.orgId, orgId), eq(projectBuild.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** Upsert the build state, touching only the given fields. */
export async function setBuild(
  db: Db,
  orgId: string,
  projectId: string,
  fields: Partial<Omit<BuildState, 'orgId' | 'projectId'>>,
): Promise<void> {
  await db
    .insert(projectBuild)
    .values({ orgId, projectId, ...fields, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [projectBuild.orgId, projectBuild.projectId],
      set: { ...fields, updatedAt: new Date() },
    });
}

/** Renew a temporary development-preview lease from its proxy hostname. */
export async function renewPreviewLeaseBySlug(db: Db, slug: string, activeUntil: Date): Promise<void> {
  await db.update(projectBuild).set({ previewActiveUntil: activeUntil }).where(eq(projectBuild.previewSlug, slug));
}

/**
 * Detach the sandbox from a project (it was stopped/deleted). Clears the session
 * and staged-changes flag too: both live on the sandbox disk, so neither can
 * outlive it — stale state would make the next --resume fail or offer a ship
 * with nothing to push (Toile's persistSandboxId(null) lesson).
 */
export async function clearSandbox(db: Db, orgId: string, projectId: string, preserveCheckpoint = false): Promise<void> {
  await setBuild(db, orgId, projectId, {
    sandboxId: null,
    claudeSessionId: null,
    codexSessionId: null,
    ...(preserveCheckpoint ? {} : {
      stagedChangesReady: false,
      dirtyRunId: null,
      dirtyThreadId: null,
      dirtyAgent: null,
      dirtyObservedAt: null,
      checkpointArchiveBase64: null,
      checkpointSha256: null,
      checkpointBytes: null,
      checkpointCreatedAt: null,
    }),
    previewUrl: null,
    previewToken: null,
    previewTokenExpiresAt: null,
    previewRuntimeId: null,
    previewSourceRef: null,
    previewActiveUntil: null,
  });
}
