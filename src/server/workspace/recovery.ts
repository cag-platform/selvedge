import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentRuns, projectBuild } from '../db/schema/index.js';
import { reconnectExistingSandbox, isExpiredWorkspaceError } from '../build/sandbox.js';
import { recordRunEvent, terminal, type RunState } from './coordinator.js';
import { getAgentRuntimeJob } from '../companion/agentRuntime.js';
import { getAppleRuntimeJob } from '../companion/appleRuntime.js';

export type ProcessObservation = { state: 'alive' | 'completed' | 'dead' | 'missing' | 'unknown'; exitCode?: number; detail?: string };

/** An explicit, project-scoped check. Unknown credentials/network state never mean dead. */
export async function recoverRun(db: Db, orgId: string, projectId: string, runId: string,
  probe?: (facts: Record<string, unknown>) => Promise<ProcessObservation>) {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), eq(agentRuns.id, runId)));
  if (!run) throw new Error('No such run');
  if (terminal.has(run.lifecycle as RunState)) return { run, observation: { state: 'unknown', detail: 'Run is already terminal; no compute was contacted.' } };
  const facts = (run.runtimeFacts.process_started ?? {}) as Record<string, unknown>;
  const observation = await (probe ?? (async (processFacts): Promise<ProcessObservation> => {
    if ((processFacts.runtimeType === 'companion' || processFacts.runtimeType === 'apple') && typeof processFacts.jobId === 'string') {
      const job = await (processFacts.runtimeType === 'apple' ? getAppleRuntimeJob : getAgentRuntimeJob)(db, orgId, processFacts.jobId);
      if (job?.state === 'succeeded' || job?.state === 'failed') return { state: 'completed', exitCode: job.state === 'succeeded' ? 0 : 1, detail: 'Completion reported by the connected device.' };
      return { state: 'unknown', detail: 'The connected device has not reported completion. A queued/running database row is not proof of a live process.' };
    }
    const { logPath, pidPath } = processFacts;
    if (typeof logPath !== 'string' || typeof pidPath !== 'string' ||
        !/^\/tmp\/selvedge-turn-[a-z0-9]+\.log$/.test(logPath) || !/^\/tmp\/selvedge-turn-[a-z0-9]+\.pid$/.test(pidPath)) {
      return { state: 'unknown', detail: 'This adapter has no persisted process handle. Ownership is retained.' };
    }
    try {
      const sandbox = await reconnectExistingSandbox(db, orgId, projectId);
      const result = await sandbox.process.executeCommand(`tail -c 4096 ${logPath} 2>/dev/null; echo "__STATE:$(kill -0 $(cat ${pidPath} 2>/dev/null) 2>/dev/null && echo ALIVE || echo DONE)"`, undefined, undefined, 30);
      if (result.exitCode !== 0) return { state: 'unknown', detail: 'Process inspection failed.' };
      const output = result.result ?? '';
      const exit = /__EXIT:(\d+)/.exec(output);
      if (exit) return { state: 'completed', exitCode: Number(exit[1]) };
      if (output.includes('__STATE:ALIVE')) return { state: 'alive' };
      if (output.includes('__STATE:DONE')) return { state: 'dead' };
      return { state: 'unknown', detail: 'No authoritative process state returned.' };
    } catch (error) {
      return isExpiredWorkspaceError(error) ? { state: 'missing' } : { state: 'unknown', detail: 'The workspace could not be inspected. Reconnect its provider before retrying.' };
    }
  }))(facts);
  await recordRunEvent(db, orgId, runId, { key: `recovery:${ulid()}`, kind: 'recovery_observed', source: 'sandbox', payload: { ...observation, originalProcessSurvived: observation.state === 'alive' } });
  if (observation.state === 'dead' || observation.state === 'missing' || observation.state === 'completed' && observation.exitCode !== 0) {
    await recordRunEvent(db, orgId, runId, { key: 'recovered-termination', kind: 'failed', source: 'coordinator', payload: { terminationReason: `recovery_${observation.state}`, exitCode: observation.exitCode ?? null, summary: 'The original execution ended. Start a new turn intentionally; no replacement was started.' } });
  } else if (observation.state === 'completed') {
    // Process exit alone is not proof that the requested work or tests passed.
    await recordRunEvent(db, orgId, runId, { key: 'recovered-result', kind: 'blocked', source: 'agent', payload: { blocker: 'The process finished while disconnected. Review its result before continuing.', exitCode: 0, verification: 'unavailable' } });
  }
  const [current] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  const [workspace] = await db.select({ sandboxId: projectBuild.sandboxId, checkpointCreatedAt: projectBuild.checkpointCreatedAt }).from(projectBuild).where(and(eq(projectBuild.orgId, orgId), eq(projectBuild.projectId, projectId)));
  return { run: current!, observation, workspace };
}
