import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { getBuild } from '../build/store.js';
import type { AgentId } from '../../shared/agents.js';
import type { ContextFact, ProjectKnowledgeClaim, TaskContextCapsule } from '../../shared/types/contextCapsule.js';

const MAX_HISTORY = 24;
const MAX_CHANGED_FILES = 40;
const MAX_CLAIMS = 30;

export type CompileContextInput = {
  orgId: string;
  projectId: string | null;
  threadId: string;
  userRequest: string;
  /** Supplied by the future Project Brain. The compiler only filters it. */
  projectKnowledge?: readonly ProjectKnowledgeClaim[];
  /** Already resolved by the caller; no opinion is silently treated as truth. */
  acceptedDecisions?: readonly ContextFact[];
  relevantCodeEvidence?: readonly ContextFact[];
  referencedPriorAnswers?: readonly ContextFact[];
  /** Fresh read-only observation supplied by the sandbox boundary. */
  executionState?: {
    observedAt: Date;
    changedFiles: readonly string[];
    diffSummary: string | null;
  } | null;
  now?: Date;
};

function fact(value: string, source: ContextFact['source'], observedAt: Date, freshness: ContextFact['freshness'], reference?: string): ContextFact {
  return { value, source, observed_at: observedAt.toISOString(), freshness, ...(reference ? { reference } : {}) };
}

/** Stable JSON for a content hash. capsule_id and generated_at are receipts, not content. */
function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function renderTaskContextCapsule(capsule: TaskContextCapsule): string {
  return [
    `TASK CONTEXT CAPSULE ${capsule.capsule_id} (schema ${capsule.schema_version}, hash ${capsule.content_hash})`,
    `Generated ${capsule.generated_at}. This is an immutable point-in-time projection, not durable project memory.`,
    '',
    'KNOWN ALREADY',
    JSON.stringify(capsule.known_already, null, 2),
    '',
    'OBSERVED NOW',
    JSON.stringify(capsule.observed_now, null, 2),
    '',
    'KNOWN OMISSIONS',
    capsule.omissions.length ? capsule.omissions.map((o) => `- ${o.item}: ${o.reason}`).join('\n') : '- None recorded.',
    '',
    'Treat agent opinions as discussion. Do not promote them to project truth. Repository observations outrank historical summaries when they conflict.',
  ].join('\n');
}

/**
 * The one model-agnostic compilation seam: Project Brain/pack + thread + live
 * execution evidence in, immutable TaskContextCapsule out.
 */
export async function compileTaskContext(db: Db, input: CompileContextInput): Promise<TaskContextCapsule> {
  const now = input.now ?? new Date();
  const [pack, build, messages, runs] = await Promise.all([
    input.projectId ? getPack(db, input.orgId, input.projectId).catch(() => null) : Promise.resolve(null),
    input.projectId ? getBuild(db, input.orgId, input.projectId).catch(() => null) : Promise.resolve(null),
    db.select().from(agentMessages).where(and(eq(agentMessages.orgId, input.orgId), eq(agentMessages.threadId, input.threadId))).orderBy(desc(agentMessages.createdAt)).limit(MAX_HISTORY),
    input.projectId
      ? db.select().from(agentRuns).where(and(eq(agentRuns.orgId, input.orgId), eq(agentRuns.threadId, input.threadId))).orderBy(desc(agentRuns.createdAt)).limit(12)
      : Promise.resolve([]),
  ]);

  const active = runs.find((run) => run.status === 'running' || run.status === 'queued') ?? null;
  const latest = runs[0] ?? null;
  const latestWithChanges = runs.find((run) => Array.isArray(run.changedPaths) && run.changedPaths.length > 0) ?? null;
  const latestVerified = runs.find((run) => run.verdict !== null) ?? null;
  const recordedChanged = (Array.isArray(latestWithChanges?.changedPaths) ? latestWithChanges.changedPaths : [])
    .filter((path): path is string => typeof path === 'string')
    .slice(0, MAX_CHANGED_FILES);
  const changed = (input.executionState?.changedFiles ?? recordedChanged).slice(0, MAX_CHANGED_FILES);
  const changedObservedAt = input.executionState?.observedAt ?? latestWithChanges?.finishedAt ?? build?.dirtyObservedAt ?? now;
  const graduated = (input.projectKnowledge ?? [])
    .filter((claim) => claim.status === 'graduated' || claim.status === 'verified')
    .slice(0, MAX_CLAIMS)
    .map((claim) => ({ ...claim, evidence: [...claim.evidence], outcome_history: claim.outcome_history ? [...claim.outcome_history] : undefined }));
  const ownerHistory = messages.filter((message) => message.role === 'owner');
  const unanswered = ownerHistory.slice(1, 4).map((message) => fact(message.content, 'thread', message.createdAt, 'recent', message.id));
  // Recent consulted answers remain DISCUSSION. They are carried so an owner
  // can say “use GPT's suggestion” on the next builder turn, but they never
  // enter accepted_decisions or graduated knowledge by implication.
  const recentConsultedAnswers = messages
    .filter((message) => message.role === 'agent' && typeof (message.meta as { consultation_id?: unknown } | null)?.consultation_id === 'string')
    .slice(0, 6)
    .map((message) => {
      const answeredBy = (message.meta as { answered_by?: unknown } | null)?.answered_by;
      return fact(`${typeof answeredBy === 'string' ? answeredBy : 'agent'} opinion: ${message.content}`, 'thread', message.createdAt, 'recent', message.id);
    });
  // The existing pack is durable knowledge but does not yet expose a single
  // pack-level observation timestamp. Say that honestly instead of inventing
  // one; the future claim provider carries effective time per claim.
  const packObserved = now;

  const knownAlready: TaskContextCapsule['known_already'] = {
    product_intent: pack ? [fact(pack.identity.owner_description, 'project_pack', packObserved, 'historical')] : [],
    architecture: pack?.topology.stack_summary ? [fact(pack.topology.stack_summary, 'project_pack', packObserved, 'historical')] : [],
    business_rules_and_constraints: pack ? [fact(`Stakes: ${pack.stakes.tier}; handles money: ${pack.stakes.touches_money ? 'yes' : 'no'}.`, 'project_pack', packObserved, 'historical')] : [],
    accepted_decisions: [...(input.acceptedDecisions ?? [])],
    prior_failures_and_outcomes: runs.filter((run) => run.status === 'failed' || run.verdict !== null).slice(0, 6).map((run) => fact(`${run.agent ?? 'agent'} run ${run.status}${run.verdict ? `; verification: ${run.verdict}` : ''}`, run.verdict ? 'verification' : 'agent_run', run.finishedAt ?? run.createdAt, 'recent', run.id)),
    graduated_project_knowledge: graduated,
  };
  const observedNow: TaskContextCapsule['observed_now'] = {
    current_objective: active || latest ? fact((active ?? latest)!.prompt.replace(/^plan:\s*/, ''), 'agent_run', (active ?? latest)!.startedAt ?? (active ?? latest)!.createdAt, active ? 'current' : 'recent', (active ?? latest)!.id) : fact(input.userRequest, 'thread', now, 'current'),
    latest_owner_request: fact(input.userRequest, 'thread', now, 'current'),
    open_questions: unanswered,
    current_builder: ((active?.agent ?? build?.dirtyAgent) as AgentId | null) ?? null,
    active_run: active ? { id: active.id, status: active.status, started_at: active.startedAt?.toISOString() ?? null } : null,
    changed_files: changed.map((path) => fact(path, 'git', changedObservedAt, input.executionState ? 'current' : 'recent', latestWithChanges?.id)),
    diff_summary: input.executionState?.diffSummary
      ? fact(input.executionState.diffSummary, 'git', input.executionState.observedAt, 'current')
      : changed.length ? fact(`${changed.length} changed file${changed.length === 1 ? '' : 's'} recorded; semantic diff summary unavailable.`, 'git', changedObservedAt, 'recent', latestWithChanges?.id) : null,
    latest_verification: latestVerified ? fact(`Verdict: ${latestVerified.verdict}`, 'verification', latestVerified.finishedAt ?? latestVerified.createdAt, 'recent', latestVerified.id) : null,
    blocker: latest?.status === 'failed' ? fact(`The latest ${latest.agent ?? 'agent'} run failed.`, 'agent_run', latest.finishedAt ?? latest.createdAt, 'current', latest.id) : null,
    next_intended_action: null,
    relevant_code_evidence: [...(input.relevantCodeEvidence ?? [])],
    referenced_prior_answers: [...(input.referencedPriorAnswers ?? []), ...recentConsultedAnswers],
  };
  const omissions: TaskContextCapsule['omissions'] = [];
  if (!pack) omissions.push({ item: 'durable project context', reason: 'No existing project context pack was available.' });
  if (!input.executionState) omissions.push({ item: 'live sandbox worktree', reason: build?.sandboxId ? 'The sandbox could not be inspected at compilation time; changed files come only from durable run evidence.' : 'No active sandbox was recorded; changed files come only from durable run evidence.' });
  if (!changed.length) omissions.push({ item: 'changed files and diff summary', reason: 'No completed run has recorded changed paths yet. An in-flight agent may still be editing.' });
  if (!latestVerified) omissions.push({ item: 'latest verification', reason: 'No run in this thread has a recorded verification verdict.' });
  if (!input.projectKnowledge) omissions.push({ item: 'Project Brain claims', reason: 'The durable ProjectKnowledgeClaim provider is not connected in this slice.' });

  const content = { project_id: input.projectId, thread_id: input.threadId, known_already: knownAlready, observed_now: observedNow, omissions };
  return {
    schema_version: 1,
    capsule_id: ulid(),
    content_hash: hashOf(content),
    generated_at: now.toISOString(),
    project_id: input.projectId,
    thread_id: input.threadId,
    known_already: knownAlready,
    observed_now: observedNow,
    omissions,
  };
}
