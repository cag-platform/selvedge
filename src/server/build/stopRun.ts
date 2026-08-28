import { ulid } from 'ulid';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { stopSandbox } from './sandbox.js';

/**
 * ENDING A TURN THAT IS STILL GOING — and never leaving a lock behind.
 *
 * One turn runs per project at a time, enforced by looking for an agent_runs
 * row still marked `running`. That lock is right; what was missing was every
 * way out of it except waiting.
 *
 * Two ways a conversation got stuck:
 *
 * A turn that never started. `runAgentTurn` writes its run row before it
 * touches the sandbox, so anything that threw on the way in — a repo it
 * couldn't clone, a sandbox that wouldn't come up — left `running` behind with
 * no process anywhere. The thread said "Working on it…" about nothing, and the
 * project refused new work for forty-five minutes. `failActiveRun` closes that
 * row when the turn dies on the way in.
 *
 * A turn that really is running, and shouldn't be. There was no stop button at
 * all. `stopActiveRun` is that button, and it is honest about what it does: it
 * suspends the sandbox, which is what actually halts the compute and the
 * meter, closes the run, and says plainly in the thread that files already
 * written are still there and nothing was shipped. Stopping is not undoing,
 * and the sentence never implies it is.
 */

/** Runs older than this are stale rather than live — the same window the routes use. */
export const STUCK_RUN_MS = 45 * 60 * 1000;

export type StopOutcome =
  | { stopped: true; runId: string }
  | { stopped: false; reason: 'nothing_running' };

async function liveRun(db: Db, orgId: string, projectId: string) {
  const [row] = await db
    .select({ id: agentRuns.id, threadId: agentRuns.threadId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.projectId, projectId),
        eq(agentRuns.status, 'running'),
        gte(agentRuns.startedAt, new Date(Date.now() - STUCK_RUN_MS)),
      ),
    )
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Close the run this project has in flight, because the owner said stop.
 *
 * The sandbox is suspended first: a run marked finished while the machine
 * still churns would be a button that lies about the one thing it is for.
 * Suspending keeps the filesystem, so whatever the agent had already written
 * survives — it is a stop, not a rollback.
 */
export async function stopActiveRun(
  db: Db,
  orgId: string,
  projectId: string,
  deps: { halt?: (db: Db, orgId: string, projectId: string) => Promise<void> } = {},
): Promise<StopOutcome> {
  const run = await liveRun(db, orgId, projectId);
  if (!run) return { stopped: false, reason: 'nothing_running' };

  // Best-effort, and deliberately not fatal: if the workspace can't be reached, the
  // owner still gets their conversation back rather than staying locked out of
  // it by a second failure.
  await (deps.halt ?? stopSandbox)(db, orgId, projectId).catch(() => undefined);

  await db
    .update(agentRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, run.id)));

  if (run.threadId) {
    await db
      .insert(agentMessages)
      .values({
        id: ulid(),
        orgId,
        projectId,
        threadId: run.threadId,
        role: 'agent',
        content:
          'Stopped. Anything already written to files is still there, and nothing was shipped — say what you want instead and I\'ll pick it up from here.',
        runId: run.id,
      })
      .catch(() => undefined);
  }

  return { stopped: true, runId: run.id };
}

/**
 * Close the run when a turn died on the way in, so the failure costs one
 * message rather than forty-five minutes of a project that won't take work.
 * The caller writes the sentence; this only unlocks.
 */
export async function failActiveRun(db: Db, orgId: string, projectId: string): Promise<void> {
  const run = await liveRun(db, orgId, projectId);
  if (!run) return;
  await db
    .update(agentRuns)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, run.id)))
    .catch(() => undefined);
}
