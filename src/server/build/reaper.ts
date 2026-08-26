import { and, eq, gte } from 'drizzle-orm';
import { Daytona, type Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { agentRuns, projectBuild } from '../db/schema/index.js';
import { reapSandboxes, reconcileSandboxes, type OpenSegment, type ReapResult, type Reconciliation } from './metering.js';
import { SANDBOX_AUTO_ARCHIVE_MINUTES } from './sandbox.js';

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

let client: Daytona | null = null;
function daytona(): Daytona {
  if (!client) client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  return client;
}

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
      const sandbox = await daytona().get(segment.sandboxId);
      if (sandbox.state === 'started') await sandbox.stop();
    },
  });
}

export type ArchiveMaintenance = { policyApplied: string[]; archived: string[] };

/**
 * Free container disk quota without deleting work. Only Selvedge-owned,
 * already-stopped sandboxes are eligible; recent/unknown activity receives the
 * policy but is not archived eagerly.
 */
export async function maintainSandboxArchives(
  now = new Date(),
  deps: { list?: () => AsyncIterable<Sandbox> } = {},
): Promise<ArchiveMaintenance> {
  const policyApplied: string[] = [];
  const archived: string[] = [];
  for await (const sandbox of (deps.list ? deps.list() : daytona().list())) {
    if (!sandbox.labels?.['selvedge/org'] || !sandbox.labels?.['selvedge/project']) continue;
    await sandbox.setAutoArchiveInterval(SANDBOX_AUTO_ARCHIVE_MINUTES);
    policyApplied.push(sandbox.id);
    const lastActivity = sandbox.lastActivityAt ? new Date(sandbox.lastActivityAt).getTime() : Number.NaN;
    if (sandbox.state === 'stopped' && Number.isFinite(lastActivity) && now.getTime() - lastActivity >= SANDBOX_AUTO_ARCHIVE_MINUTES * 60_000) {
      await sandbox.archive();
      archived.push(sandbox.id);
    }
  }
  return { policyApplied, archived };
}

/**
 * The daily no-silent-leak check. Asks Daytona what it is actually running and
 * compares it with what we think — in both directions, because each direction
 * fails differently and only one of them is expensive.
 */
export async function runSandboxReconciliation(db: Db): Promise<Reconciliation> {
  return reconcileSandboxes(db, {
    listRunning: async () => {
      // The SDK hands back an async iterator (it pages behind the scenes), so
      // this walks it rather than treating it as an array.
      const running: string[] = [];
      for await (const sandbox of daytona().list()) {
        if (sandbox.state === 'started') running.push(sandbox.id);
      }
      return running;
    },
    stop: async (sandboxId) => {
      const sandbox = await daytona().get(sandboxId);
      if (sandbox.state === 'started') await sandbox.stop();
    },
  });
}
