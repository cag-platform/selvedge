import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, projectBuild } from '../db/schema/index.js';
import { reapSandboxes, reconcileSandboxes, type OpenSegment, type ReapResult, type Reconciliation } from './metering.js';
import { activeDevelopmentWorkspaceIds, stopDevelopmentWorkspaceById } from './sandbox.js';

/**
 * THE SWEEP, WIRED TO THE REAL WORLD.
 *
 * `metering.ts` holds the rules and takes its two facts — "is this project
 * working?" and "stop this" — as arguments, so all of it can be tested without
 * a Daytona account. This file is the half that cannot be: the queries and the
 * API calls.
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
        eq(agentRuns.status, 'running'),
        gte(agentRuns.startedAt, new Date(now.getTime() - STUCK_RUN_MS)),
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
      await stopDevelopmentWorkspaceById(segment.sandboxId);
    },
  });
}

/**
 * The daily no-silent-leak check. Asks Daytona what it is actually running and
 * compares it with what we think — in both directions, because each direction
 * fails differently and only one of them is expensive.
 */
export async function runSandboxReconciliation(db: Db): Promise<Reconciliation> {
  return reconcileSandboxes(db, {
    listRunning: async () => {
      return activeDevelopmentWorkspaceIds();
    },
    stop: async (sandboxId) => {
      await stopDevelopmentWorkspaceById(sandboxId);
    },
  });
}
