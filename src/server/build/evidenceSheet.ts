import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns, cards } from '../db/schema/index.js';
import type { CardAct } from '../cards/types.js';
import type { RunRecord, ToolEvent } from '../../shared/types/toolEvent.js';
import type { DeepLinkDestination } from '../../shared/types/continuation.js';
import type { EvidenceCheck, EvidenceOutcome, EvidenceSheet } from '../../shared/types/evidenceSheet.js';

const MAX_PATHS = 100;
const MAX_ACTS = 100;
const MAX_TOOLS = 200;
const MAX_CHECKS = 100;
const CHECK_COMMAND = /(^|\s)(test|tests|pytest|vitest|jest|mocha|lint|typecheck|check|build|cargo\s+test|go\s+test|xcodebuild)(\s|$)/i;

function statusFor(outcome: EvidenceOutcome): EvidenceSheet['status'] {
  if (outcome === 'verified') return 'healthy';
  if (outcome === 'did_not_work') return 'needs';
  return 'unknown';
}

function words(outcome: EvidenceOutcome): { summary: string; explanation: string } {
  switch (outcome) {
    case 'verified': return { summary: 'Verified', explanation: 'An acceptance observation confirmed the requested change and no recorded check failed.' };
    case 'probably': return { summary: 'Probably working', explanation: 'The change completed and recorded checks passed, but no acceptance observation fully confirmed the requested behavior.' };
    case 'inconclusive': return { summary: "I can't tell", explanation: 'The record does not contain enough successful verification to claim the change worked.' };
    case 'did_not_work': return { summary: "It didn't work", explanation: 'The run or a recorded check failed, so this is not presented as a successful change.' };
    case 'stopped': return { summary: 'Stopped', explanation: 'Work ended before completion. Any recorded changes remain evidence, not proof of a finished result.' };
  }
}

function destinations(projectId: string, kind: 'run' | 'card', id: string, threadId: string | null): EvidenceSheet['destinations'] {
  const evidenceKind = kind === 'run' ? 'run_evidence' : 'card_evidence';
  const query = `${kind}=${encodeURIComponent(id)}`;
  const evidence: DeepLinkDestination = {
    kind: evidenceKind,
    web_path: threadId ? `/inbox/${encodeURIComponent(threadId)}?evidence=${encodeURIComponent(id)}` : `/projects/${encodeURIComponent(projectId)}?tab=history&${query}`,
    ios_path: `selvedge://projects/${encodeURIComponent(projectId)}/evidence/${kind}s/${encodeURIComponent(id)}`,
    project_id: projectId,
    ...(threadId ? { thread_id: threadId } : {}),
    ...(kind === 'run' ? { run_id: id } : { card_id: id }),
  };
  return {
    evidence,
    thread: threadId ? { kind: 'thread', web_path: `/inbox/${encodeURIComponent(threadId)}`, ios_path: `selvedge://threads/${encodeURIComponent(threadId)}`, project_id: projectId, thread_id: threadId } : null,
    project_history: { kind: 'project', web_path: `/projects/${encodeURIComponent(projectId)}?tab=history&${query}`, ios_path: `selvedge://projects/${encodeURIComponent(projectId)}/history?${query}`, project_id: projectId },
  };
}

function toolChecks(tools: ToolEvent[]): EvidenceCheck[] {
  return tools.flatMap((tool) => {
    const command = tool.input?.command;
    if (!command || !CHECK_COMMAND.test(command)) return [];
    return [{ kind: 'project', name: command.slice(0, 240), outcome: tool.ok === true ? 'passed' : tool.ok === false ? 'failed' : 'unknown', detail: tool.note ?? null, raw_outcome: tool.ok === undefined ? null : String(tool.ok) } satisfies EvidenceCheck];
  });
}

function boundedTool(tool: ToolEvent): ToolEvent {
  const input = tool.input ? Object.fromEntries(Object.entries(tool.input).slice(0, 20).map(([key, value]) => [key.slice(0, 100), String(value).slice(0, 2000)])) : undefined;
  return { id: String(tool.id).slice(0, 200), name: String(tool.name).slice(0, 120), detail: String(tool.detail).slice(0, 2000), ...(input ? { input } : {}), ...(tool.ok !== undefined ? { ok: tool.ok } : {}), ...(tool.note ? { note: String(tool.note).slice(0, 500) } : {}) };
}

function checkFromUnknown(value: unknown): EvidenceCheck | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const rawKind = typeof row.kind === 'string' ? row.kind : 'unknown';
  const kind: EvidenceCheck['kind'] = rawKind === 'smoke' || rawKind === 'regression' || rawKind === 'acceptance' ? rawKind : 'unknown';
  const raw = typeof row.outcome === 'string' ? row.outcome : null;
  const outcome: EvidenceCheck['outcome'] = raw === 'pass' ? 'passed' : raw === 'fail' ? 'failed' : raw === 'could_not_run' ? 'unavailable' : 'unknown';
  return { kind, name: typeof row.name === 'string' ? row.name.slice(0, 240) : 'Unnamed check', outcome, detail: typeof row.detail === 'string' ? row.detail.slice(0, 1000) : null, raw_outcome: raw };
}

function normalize(raw: string | null, supported: EvidenceOutcome, warnings: string[]): EvidenceOutcome {
  if (!raw) return supported;
  if (raw === 'failed' || raw === 'didnt_work' || raw === 'did_not_work') return 'did_not_work';
  if (raw === 'stopped') return 'stopped';
  if (raw === 'inconclusive') return 'inconclusive';
  if (raw === 'verified') {
    if (supported === 'verified') return 'verified';
    warnings.push('The stored verified outcome was downgraded because the available evidence has no successful acceptance observation.');
    return supported;
  }
  if (raw === 'probably') {
    if (supported === 'verified' || supported === 'probably') return 'probably';
    warnings.push('The stored probably outcome was downgraded because the available evidence does not support a success claim.');
    return supported;
  }
  warnings.push(`Unknown outcome "${raw}" was treated as inconclusive.`);
  return supported === 'did_not_work' || supported === 'stopped' ? supported : 'inconclusive';
}

export function summarizeRunEvidence(
  run: { status: string; verdict: string | null; changedPaths: unknown },
  record: RunRecord | null,
): Pick<EvidenceSheet, 'outcome' | 'status' | 'summary' | 'explanation'> {
  const checks = toolChecks(Array.isArray(record?.tools) ? record.tools : []);
  let fallback: EvidenceOutcome = 'inconclusive';
  if (run.status === 'cancelled' || run.status === 'stopped') fallback = 'stopped';
  else if (run.status === 'failed' || checks.some((check) => check.outcome === 'failed')) fallback = 'did_not_work';
  else if (run.status === 'succeeded' && checks.some((check) => check.outcome === 'passed') && Array.isArray(run.changedPaths) && run.changedPaths.length > 0) fallback = 'probably';
  const outcome = normalize(run.verdict, fallback, []);
  return { outcome, status: statusFor(outcome), ...words(outcome) };
}

export async function runEvidenceSheet(db: Db, orgId: string, projectId: string, runId: string): Promise<EvidenceSheet | null> {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId), eq(agentRuns.id, runId))).limit(1);
  if (!run) return null;
  const [activity] = await db.select({ meta: agentMessages.meta }).from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.projectId, projectId), eq(agentMessages.runId, runId), eq(agentMessages.role, 'activity'))).limit(1);
  const record = activity?.meta as RunRecord | null;
  const sourceTools = Array.isArray(record?.tools) ? record.tools : [];
  const tools = sourceTools.slice(0, MAX_TOOLS).map(boundedTool);
  const checks = toolChecks(tools);
  const warnings: string[] = [];
  if (record?.truncated || sourceTools.length > MAX_TOOLS) warnings.push('The tool record was truncated; raw evidence is incomplete.');
  const rawVerdict = run.verdict;
  const fallback = summarizeRunEvidence(run, record).outcome;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped'].includes(run.status)) warnings.push(`Unknown run status "${run.status}" did not produce a success claim.`);
  const outcome = normalize(rawVerdict, fallback, warnings);
  const changed = Array.isArray(run.changedPaths) ? run.changedPaths.filter((path): path is string => typeof path === 'string').map((path) => path.slice(0, 500)) : [];
  const copy = words(outcome);
  return {
    schema_version: 1, project_id: projectId, source: { kind: 'run', id: run.id, thread_id: run.threadId }, outcome, raw_outcome: rawVerdict ?? run.status,
    status: statusFor(outcome), ...copy,
    changed_files: { paths: changed.slice(0, MAX_PATHS), total: changed.length, truncated: changed.length > MAX_PATHS },
    checks_run: checks.filter((check) => check.outcome === 'passed' || check.outcome === 'failed'), acceptance_observation: null,
    unavailable_checks: checks.filter((check) => check.outcome === 'unavailable' || check.outcome === 'unknown'),
    raw_evidence: { tools, acts: [], truncated: Boolean(record?.truncated) || sourceTools.length > MAX_TOOLS },
    timestamps: { started_at: run.startedAt?.toISOString() ?? null, finished_at: run.finishedAt?.toISOString() ?? null, generated_at: new Date().toISOString() },
    warnings: [...warnings, ...(changed.length > MAX_PATHS ? [`Changed files were limited to ${MAX_PATHS} of ${changed.length}.`] : [])],
    destinations: destinations(projectId, 'run', run.id, run.threadId),
  };
}

export async function cardEvidenceSheet(db: Db, orgId: string, projectId: string, cardId: string): Promise<EvidenceSheet | null> {
  const [card] = await db.select().from(cards).where(and(eq(cards.orgId, orgId), eq(cards.projectId, projectId), eq(cards.id, cardId))).limit(1);
  if (!card) return null;
  const allActs = Array.isArray(card.acts) ? card.acts as CardAct[] : [];
  const completed = [...allActs].reverse().find((act) => act.kind === 'completed');
  const results = Array.isArray(completed?.meta?.results) ? completed!.meta!.results as unknown[] : [];
  const allChecks = results.map(checkFromUnknown).filter((check): check is EvidenceCheck => check !== null);
  const checks = allChecks.slice(0, MAX_CHECKS);
  const allTools = allActs.flatMap((act) => Array.isArray(act.meta?.tools) ? act.meta.tools as ToolEvent[] : []);
  const tools = allTools.slice(0, MAX_TOOLS).map(boundedTool);
  const warnings: string[] = [];
  const rawVerdict = card.verdict;
  const acceptance = checks.find((check) => check.kind === 'acceptance') ?? null;
  const failed = checks.some((check) => check.outcome === 'failed');
  const passed = checks.some((check) => check.outcome === 'passed');
  const fallback: EvidenceOutcome = card.state === 'stopped' ? 'stopped'
    : card.state === 'failed' || failed ? 'did_not_work'
      : acceptance?.outcome === 'passed' ? 'verified'
        : card.state === 'done' && passed ? 'probably' : 'inconclusive';
  const outcome = normalize(rawVerdict, fallback, warnings);
  const paths = [...new Set(tools.flatMap((tool) => {
    const path = tool.input?.file_path ?? tool.input?.path;
    return path ? [path] : [];
  }))];
  const rawTruncated = allActs.length > MAX_ACTS || allTools.length > MAX_TOOLS || allChecks.length > MAX_CHECKS;
  if (rawTruncated) warnings.push('Raw card evidence was bounded; the complete card record remains in the project export.');
  const copy = words(outcome);
  return {
    schema_version: 1, project_id: projectId, source: { kind: 'card', id: card.id, thread_id: null }, outcome, raw_outcome: rawVerdict ?? card.state,
    status: statusFor(outcome), ...copy,
    changed_files: { paths: paths.slice(0, MAX_PATHS), total: paths.length, truncated: paths.length > MAX_PATHS },
    checks_run: checks.filter((check) => check.outcome === 'passed' || check.outcome === 'failed'), acceptance_observation: acceptance,
    unavailable_checks: checks.filter((check) => check.outcome === 'unavailable' || check.outcome === 'unknown'),
    raw_evidence: { tools, acts: allActs.slice(-MAX_ACTS).map((act) => ({ at: String(act.at).slice(0, 100), kind: String(act.kind).slice(0, 120), detail: String(act.detail).slice(0, 2000), ...(act.meta ? { meta: { ...(typeof act.meta.verdict === 'string' ? { verdict: act.meta.verdict.slice(0, 100) } : {}), ...(typeof act.meta.gradedBy === 'string' ? { gradedBy: act.meta.gradedBy.slice(0, 100) } : {}) } } : {}) })), truncated: rawTruncated },
    timestamps: { started_at: card.createdAt.toISOString(), finished_at: ['done', 'failed', 'stopped', 'declined'].includes(card.state) ? card.updatedAt.toISOString() : null, generated_at: new Date().toISOString() },
    warnings: [...warnings, ...(paths.length > MAX_PATHS ? [`Changed files were limited to ${MAX_PATHS} of ${paths.length}.`] : [])],
    destinations: destinations(projectId, 'card', card.id, null),
  };
}
