import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentRuntimeHosts, agentRuntimeJobs } from '../db/schema/index.js';

export const AGENT_RUNTIME_HEARTBEAT_MS = 20_000;
export const AGENT_RUNTIME_ONLINE_WINDOW_MS = 75_000;
export type LocalBuilder = 'codex' | 'claude-code';
export type AgentCapabilities = { codex: boolean; claudeCode: boolean };

export type AgentRuntimeRegistration = { name: string; capabilities: AgentCapabilities };
export function checkAgentRuntimeRegistration(value: unknown): AgentRuntimeRegistration | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const caps = row.capabilities as Record<string, unknown> | undefined;
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120) return null;
  if (typeof caps?.codex !== 'boolean' || typeof caps?.claudeCode !== 'boolean') return null;
  if (!caps.codex && !caps.claudeCode) return null;
  return { name: row.name.trim(), capabilities: { codex: caps.codex, claudeCode: caps.claudeCode } };
}

export async function connectAgentRuntime(db: Db, orgId: string, tokenId: string, input: AgentRuntimeRegistration) {
  const now = new Date();
  const [host] = await db.insert(agentRuntimeHosts).values({ id: ulid(), orgId, tokenId, ...input, status: 'online', connectedAt: now, lastSeenAt: now, disconnectedAt: null })
    .onConflictDoUpdate({ target: agentRuntimeHosts.tokenId, set: { orgId, ...input, status: 'online', lastSeenAt: now, disconnectedAt: null } }).returning();
  if (!host) throw new Error('Agent runtime registration was not stored');
  return host;
}
export async function heartbeatAgentRuntime(db: Db, orgId: string, tokenId: string) {
  const [host] = await db.update(agentRuntimeHosts).set({ status: 'online', lastSeenAt: new Date(), disconnectedAt: null })
    .where(and(eq(agentRuntimeHosts.orgId, orgId), eq(agentRuntimeHosts.tokenId, tokenId))).returning();
  return host ?? null;
}
export async function disconnectAgentRuntime(db: Db, orgId: string, tokenId: string) {
  const [host] = await db.update(agentRuntimeHosts).set({ status: 'offline', disconnectedAt: new Date() })
    .where(and(eq(agentRuntimeHosts.orgId, orgId), eq(agentRuntimeHosts.tokenId, tokenId))).returning();
  return host ?? null;
}
export async function availableAgentRuntime(db: Db, orgId: string, agent: LocalBuilder) {
  const cutoff = new Date(Date.now() - AGENT_RUNTIME_ONLINE_WINDOW_MS);
  const rows = await db.select().from(agentRuntimeHosts).where(and(eq(agentRuntimeHosts.orgId, orgId), eq(agentRuntimeHosts.status, 'online'), gt(agentRuntimeHosts.lastSeenAt, cutoff), isNull(agentRuntimeHosts.disconnectedAt))).orderBy(desc(agentRuntimeHosts.lastSeenAt));
  return rows.find((host) => {
    const caps = host.capabilities as AgentCapabilities;
    return agent === 'codex' ? caps.codex : caps.claudeCode;
  }) ?? null;
}
export async function listAgentRuntimes(db: Db, orgId: string) {
  const rows = await db.select().from(agentRuntimeHosts).where(eq(agentRuntimeHosts.orgId, orgId)).orderBy(desc(agentRuntimeHosts.lastSeenAt));
  const cutoff = Date.now() - AGENT_RUNTIME_ONLINE_WINDOW_MS;
  return rows.map((host) => ({ ...host, online: host.status === 'online' && !host.disconnectedAt && host.lastSeenAt.getTime() > cutoff }));
}

export type AgentRuntimeRequest = { version: 1; runId: string; threadId: string; repoFullName: string; branch: string; emptyRepo: boolean; agent: LocalBuilder; model: string; prompt: string };
export type AgentRuntimeResult = { ok: boolean; detail?: string; narrative?: string; changedPaths?: string[] };
export async function queueAgentRuntimeTurn(db: Db, orgId: string, projectId: string, request: AgentRuntimeRequest) {
  if (!await availableAgentRuntime(db, orgId, request.agent)) return null;
  const [job] = await db.insert(agentRuntimeJobs).values({ id: ulid(), orgId, projectId, agent: request.agent, request, state: 'queued' }).returning();
  return job ?? null;
}
export async function getAgentRuntimeJob(db: Db, orgId: string, jobId: string) {
  const [job] = await db.select().from(agentRuntimeJobs).where(and(eq(agentRuntimeJobs.orgId, orgId), eq(agentRuntimeJobs.id, jobId))).limit(1);
  return job ?? null;
}
export async function claimAgentRuntimeJob(db: Db, orgId: string, tokenId: string) {
  const host = await heartbeatAgentRuntime(db, orgId, tokenId);
  if (!host) return null;
  const caps = host.capabilities as AgentCapabilities;
  const supported = [caps.codex ? 'codex' : null, caps.claudeCode ? 'claude-code' : null].filter(Boolean) as string[];
  const rows = await db.select().from(agentRuntimeJobs).where(and(eq(agentRuntimeJobs.orgId, orgId), eq(agentRuntimeJobs.state, 'queued'))).orderBy(asc(agentRuntimeJobs.createdAt));
  const candidate = rows.find((job) => supported.includes(job.agent));
  if (!candidate) return null;
  const [claimed] = await db.update(agentRuntimeJobs).set({ state: 'running', hostId: host.id, claimedAt: new Date() }).where(and(eq(agentRuntimeJobs.id, candidate.id), eq(agentRuntimeJobs.state, 'queued'))).returning();
  return claimed ?? null;
}
export async function assignedAgentRuntimeJob(db: Db, orgId: string, tokenId: string, jobId: string) {
  const host = await heartbeatAgentRuntime(db, orgId, tokenId);
  if (!host) return null;
  const [job] = await db.select().from(agentRuntimeJobs).where(and(eq(agentRuntimeJobs.id, jobId), eq(agentRuntimeJobs.orgId, orgId), eq(agentRuntimeJobs.hostId, host.id), eq(agentRuntimeJobs.state, 'running'))).limit(1);
  return job ?? null;
}
export async function finishAgentRuntimeJob(db: Db, orgId: string, tokenId: string, jobId: string, result: AgentRuntimeResult) {
  const host = await heartbeatAgentRuntime(db, orgId, tokenId);
  if (!host) return null;
  const [job] = await db.update(agentRuntimeJobs).set({ state: result.ok ? 'succeeded' : 'failed', result, error: result.ok ? null : (result.detail ?? 'Local agent stopped'), finishedAt: new Date() })
    .where(and(eq(agentRuntimeJobs.id, jobId), eq(agentRuntimeJobs.orgId, orgId), eq(agentRuntimeJobs.hostId, host.id), eq(agentRuntimeJobs.state, 'running'))).returning();
  return job ?? null;
}
