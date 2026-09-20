import { ulid } from 'ulid';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, agentRunEvents, projectBuild } from '../db/schema/index.js';
import { publishLiveChat } from '../chat/live.js';

export type RunState = 'queued' | 'starting' | 'working' | 'needs_you' | 'verifying' | 'ready' | 'failed' | 'cancelled';
export const terminal = new Set<RunState>(['ready', 'failed', 'cancelled']);
const transitions: Record<RunState, RunState[]> = {
  queued: ['starting', 'failed', 'cancelled'], starting: ['working', 'failed', 'cancelled'],
  working: ['needs_you', 'verifying', 'ready', 'failed', 'cancelled'],
  needs_you: ['working', 'ready', 'failed', 'cancelled'], verifying: ['working', 'needs_you', 'ready', 'failed', 'cancelled'],
  ready: [], failed: [], cancelled: [],
};
const rules = {
  starting: ['coordinator', 'starting'], activity: ['agent', 'working'], blocked: ['agent', 'needs_you'],
  owner_response: ['owner', null], resumed: ['agent', 'working'],
  files_changed: ['git', null], git_changed: ['git', null],
  preview_starting: ['preview', null], preview_ready: ['preview', null], preview_failed: ['preview', null],
  verification_started: ['verification', 'verifying'], verification_passed: ['verification', 'ready'], verification_failed: ['verification', 'needs_you'],
  verification_observed: ['verification', null],
  ready: ['agent', 'ready'], failed: ['coordinator', 'failed'], cancelled: ['owner', 'cancelled'],
  workspace_hibernated: ['sandbox', null], workspace_resumed: ['sandbox', null],
  process_started: ['agent', null], recovery_observed: ['sandbox', null],
  release_requested: ['owner', null], release_started: ['release', 'working'], release_succeeded: ['release', 'ready'], release_failed: ['release', 'failed'],
  release_uncertain: ['release', 'needs_you'],
  reviewed: ['owner', null],
  recovered_result_accepted: ['owner', 'ready'],
} as const;
export type RunEventKind = keyof typeof rules;
export class WorkspaceBusyError extends Error {}

/** Serialize on the existing project row. An expired lease is evidence to reconcile, never permission to steal it. */
export async function createRun(db: Db, input: {
  orgId: string; projectId: string; threadId: string; requestKey: string; capsuleId: string;
  prompt: string; agent: string; model?: string; ownerId?: string; role?: 'builder' | 'consultant';
}) {
  if (!input.requestKey || input.requestKey.length > 512 || !input.capsuleId) throw new Error('A bounded request key and capsule ID are required');
  return db.transaction(async (tx) => {
    await tx.insert(projectBuild).values({ orgId: input.orgId, projectId: input.projectId }).onConflictDoNothing();
    const [workspace] = await tx.select().from(projectBuild).where(and(eq(projectBuild.orgId, input.orgId), eq(projectBuild.projectId, input.projectId))).for('update');
    const [prior] = await tx.select().from(agentRuns).where(and(eq(agentRuns.orgId, input.orgId), eq(agentRuns.projectId, input.projectId), eq(agentRuns.requestKey, input.requestKey)));
    if (prior) return { run: prior, created: false };
    const role = input.role ?? 'builder';
    if (role === 'builder' && (workspace!.leaseOwner || workspace!.provisioningKey)) throw new WorkspaceBusyError('This project already has a builder or workspace operation. Reconnect or resolve that operation first.');
    if (role === 'builder') {
      const [legacy] = await tx.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.orgId, input.orgId), eq(agentRuns.projectId, input.projectId), eq(agentRuns.runRole, 'builder'), eq(agentRuns.status, 'running'))).limit(1);
      if (legacy) throw new WorkspaceBusyError('An existing run needs reconnection or confirmed termination before another builder starts.');
    }
    const id = ulid();
    const [run] = await tx.insert(agentRuns).values({ id, orgId: input.orgId, projectId: input.projectId,
      threadId: input.threadId, ownerId: input.ownerId, requestKey: input.requestKey, capsuleId: input.capsuleId,
      prompt: input.prompt, agent: input.agent, model: input.model, runRole: role, lastActivityAt: new Date(), eventVersion: 1,
    }).returning();
    if (role === 'builder') await tx.update(projectBuild).set({ leaseOwner: id, leaseExpiresAt: new Date(Date.now() + 45 * 60_000) })
      .where(and(eq(projectBuild.orgId, input.orgId), eq(projectBuild.projectId, input.projectId)));
    await tx.insert(agentRunEvents).values({ id: ulid(), orgId: input.orgId, projectId: input.projectId, runId: id,
      eventKey: 'created', sequence: 1, kind: 'created', source: 'coordinator', payload: { ...input, role } });
    return { run: run!, created: true };
  });
}

/** The event and projection are atomic; duplicate events cannot refresh leases or reapply decisions. */
export async function recordRunEvent(db: Db, orgId: string, runId: string, event: {
  key: string; kind: RunEventKind; source: string; payload?: Record<string, unknown>;
}) {
  if (!event.key || event.key.length > 512) throw new Error('A bounded event key is required');
  const run = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId))).for('update');
    if (!current) throw new Error('No such run');
    const [duplicate] = await tx.select({ id: agentRunEvents.id }).from(agentRunEvents)
      .where(and(eq(agentRunEvents.orgId, orgId), eq(agentRunEvents.runId, runId), eq(agentRunEvents.eventKey, event.key)));
    if (duplicate) return current;
    const [authority, next] = rules[event.kind];
    if (event.source !== authority) throw new Error(`Only ${authority} may report ${event.kind}`);
    const state = current.lifecycle as RunState;
    if (event.kind === 'reviewed' && !terminal.has(state)) throw new Error('Active work cannot be marked reviewed');
    if (event.kind === 'process_started' && terminal.has(state)) throw new Error('A terminal run cannot launch a process');
    if (event.kind === 'recovered_result_accepted') {
      const observation = current.runtimeFacts.recovery_observed as { state?: string; exitCode?: number } | undefined;
      if (state !== 'needs_you' || observation?.state !== 'completed' || observation.exitCode !== 0) throw new Error('Only a confirmed completed process can be accepted after recovery');
    }
    if (next && next !== state && !transitions[state].includes(next)) throw new Error(`Invalid run transition ${state} → ${next}`);
    if (next && next === state && terminal.has(state)) throw new Error('Run is already terminal');
    const now = new Date();
    const payload = event.payload ?? {};
    await tx.insert(agentRunEvents).values({ id: ulid(), orgId, projectId: current.projectId, runId,
      eventKey: event.key, sequence: current.eventVersion + 1, kind: event.kind, source: event.source, payload, createdAt: now });
    const lifecycle = next ?? state;
    const [updated] = await tx.update(agentRuns).set({ lifecycle, eventVersion: current.eventVersion + 1,
      ...(next ? { status: terminal.has(lifecycle) ? lifecycle === 'ready' ? 'succeeded' : lifecycle : 'running' } : {}),
      ...(next === 'starting' ? { startedAt: now } : {}),
      ...(next && terminal.has(next) ? { finishedAt: now } : {}),
      ...(event.kind === 'reviewed' ? { reviewedAt: now } : {}),
      lastActivityAt: now,
      runtimeFacts: { ...current.runtimeFacts, [event.kind]: { ...payload, source: event.source, observedAt: now.toISOString() } },
    }).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId))).returning();
    if (current.runRole === 'builder') await tx.update(projectBuild).set(next && terminal.has(next)
      ? { leaseOwner: null, leaseExpiresAt: new Date(now.getTime() + 5 * 60_000) }
      : { leaseExpiresAt: new Date(now.getTime() + 45 * 60_000) })
      .where(and(eq(projectBuild.orgId, orgId), eq(projectBuild.projectId, current.projectId), eq(projectBuild.leaseOwner, runId)));
    return updated!;
  });
  if (run.threadId) publishLiveChat(orgId, run.threadId, { type: 'workspace_changed', runId });
  return run;
}

export function rollup(runs: Array<{ lifecycle: string; reviewedAt: Date | null }>) {
  if (runs.some(r => r.lifecycle === 'needs_you')) return 'needs_you';
  if (runs.some(r => ['queued', 'starting', 'working', 'verifying'].includes(r.lifecycle))) return 'working';
  if (runs.some(r => r.lifecycle === 'ready' && !r.reviewedAt)) return 'ready_to_review';
  if (runs.some(r => r.lifecycle === 'failed' && !r.reviewedAt)) return 'failed';
  return 'quiet';
}

/** Bounded by project and unread/active rows; never invokes an infrastructure provider. */
export async function projectRunStatus(db: Db, orgId: string, projectId: string) {
  const runs = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), eq(agentRuns.runRole, 'builder'), isNull(agentRuns.reviewedAt)));
  return { status: rollup(runs), runs };
}
