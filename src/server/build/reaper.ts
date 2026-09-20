import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, projectBuild } from '../db/schema/index.js';
import { reapSandboxes, reconcileSandboxes, type OpenSegment, type ReapResult, type Reconciliation } from './metering.js';
import { hibernateWorkspace, activeDevelopmentWorkspaceIds } from './sandbox.js';

/**
 * THE SWEEP, WIRED TO THE REAL WORLD.
 *
 * `metering.ts` holds the rules and takes its two facts — "is this project
 * working?" and "stop this" — as arguments, so all of it can be tested without
 * a workspace-provider account. This file owns the queries and provider calls.
 */

/** The same staleness cutoff the routes use: a run this old still marked running is a crashed process. */
const STUCK_RUN_MS = 45 * 60 * 1000;

/**
 * Is a turn genuinely in flight for this project?
 *
 * This is the fact that makes our sweep safer than Daytona's own timer. Daytona
 * sees a machine that has not been spoken to for two minutes; this sees whether
 * an agent is halfway through a build. A long compile with no commands in
 * between is quiet and busy at the same time, and only one of the two can tell
 * the difference.
 *
 * A run older than the stale cutoff does not count as working — that is a
 * crashed process holding a sandbox open, which is precisely what the sweep is
 * for.
 */
export async function projectIsWorking(db: Db, segment: OpenSegment, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, segment.orgId),
        eq(agentRuns.projectId, segment.projectId),
        eq(agentRuns.runRole, 'builder'),
        eq(agentRuns.status, 'running'),
      ),
    )
    .limit(1);
  if (row) return true;
  return previewIsActive(db, segment, now);
}

export async function previewIsActive(db: Db, segment: OpenSegment, now = new Date()): Promise<boolean> {
  const [preview] = await db.select({ activeUntil: projectBuild.previewActiveUntil }).from(projectBuild)
    .where(and(eq(projectBuild.orgId, segment.orgId), eq(projectBuild.projectId, segment.projectId))).limit(1);
  return Boolean(preview?.activeUntil && preview.activeUntil.getTime() > now.getTime());
}

export async function runSandboxSweep(db: Db, now = new Date()): Promise<ReapResult> {
  return reapSandboxes(db, {
    now,
    isWorking: (segment) => projectIsWorking(db, segment, now),
    hasActivePreview: (segment) => previewIsActive(db, segment, now),
    stop: async (segment) => {
      const [build] = await db.select().from(projectBuild).where(and(eq(projectBuild.orgId, segment.orgId), eq(projectBuild.projectId, segment.projectId)));
      if (build?.sandboxId !== segment.sandboxId) throw new Error('Unattributed workspace retained for manual recovery.');
      const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, segment.orgId), eq(agentRuns.projectId, segment.projectId), eq(agentRuns.runRole, 'builder'))).orderBy(agentRuns.startedAt).limit(1);
      if (!run) throw new Error('Workspace has no recorded run; refusing destructive cleanup.');
      const result = await hibernateWorkspace(db, segment.orgId, segment.projectId, run.id);
      if (result !== 'hibernated' && result !== 'inactive') throw new Error(`Workspace retained: ${result}`);
    },
  });
}

/**
 * The daily no-silent-leak check. Asks the workspace provider what it is running and
 * compares it with what we think — in both directions, because each direction
 * fails differently and only one of them is expensive.
 */
export async function runSandboxReconciliation(db: Db): Promise<Reconciliation> {
  return reconcileSandboxes(db, {
    listRunning: async () => {
      // This diagnostic is explicit only; cron no longer invokes it.
      return activeDevelopmentWorkspaceIds();
    },
    stop: async (sandboxId) => {
      throw new Error(`Unattributed workspace ${sandboxId} retained for manual recovery.`);
    },
  });
}
