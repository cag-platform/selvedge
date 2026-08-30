import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { appleRuntimeHosts, appleRuntimeJobs } from '../db/schema/index.js';
import { getBuild, setBuild } from '../build/store.js';

export const APPLE_RUNTIME_HEARTBEAT_MS = 20_000;
export const APPLE_RUNTIME_ONLINE_WINDOW_MS = 75_000;

export type AppleRuntimeRegistration = {
  name: string;
  xcodeVersion: string;
  macosVersion: string;
  capabilities: { xcode: true; iosSimulator: true };
};

export function checkAppleRuntimeRegistration(value: unknown): AppleRuntimeRegistration | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const capabilities = row.capabilities as Record<string, unknown> | undefined;
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120) return null;
  if (typeof row.xcodeVersion !== 'string' || !row.xcodeVersion.trim() || row.xcodeVersion.length > 500) return null;
  if (typeof row.macosVersion !== 'string' || !row.macosVersion.trim() || row.macosVersion.length > 200) return null;
  if (capabilities?.xcode !== true || capabilities.iosSimulator !== true) return null;
  return {
    name: row.name.trim(), xcodeVersion: row.xcodeVersion.trim(), macosVersion: row.macosVersion.trim(),
    capabilities: { xcode: true, iosSimulator: true },
  };
}

export async function connectAppleRuntime(db: Db, orgId: string, tokenId: string, input: AppleRuntimeRegistration) {
  const now = new Date();
  const [host] = await db.insert(appleRuntimeHosts).values({
    id: ulid(), orgId, tokenId, ...input, status: 'online', connectedAt: now, lastSeenAt: now, disconnectedAt: null,
  }).onConflictDoUpdate({
    target: appleRuntimeHosts.tokenId,
    set: { orgId, ...input, status: 'online', lastSeenAt: now, disconnectedAt: null },
  }).returning();
  if (!host) throw new Error('Apple runtime registration was not stored');
  return host;
}

export async function heartbeatAppleRuntime(db: Db, orgId: string, tokenId: string) {
  const [host] = await db.update(appleRuntimeHosts).set({ status: 'online', lastSeenAt: new Date(), disconnectedAt: null })
    .where(and(eq(appleRuntimeHosts.orgId, orgId), eq(appleRuntimeHosts.tokenId, tokenId)))
    .returning();
  return host ?? null;
}

export async function disconnectAppleRuntime(db: Db, orgId: string, tokenId: string) {
  const [host] = await db.update(appleRuntimeHosts).set({ status: 'offline', disconnectedAt: new Date() })
    .where(and(eq(appleRuntimeHosts.orgId, orgId), eq(appleRuntimeHosts.tokenId, tokenId)))
    .returning();
  return host ?? null;
}

export async function availableAppleRuntime(db: Db, orgId: string) {
  const cutoff = new Date(Date.now() - APPLE_RUNTIME_ONLINE_WINDOW_MS);
  const [host] = await db.select().from(appleRuntimeHosts).where(and(
    eq(appleRuntimeHosts.orgId, orgId), eq(appleRuntimeHosts.status, 'online'),
    gt(appleRuntimeHosts.lastSeenAt, cutoff), isNull(appleRuntimeHosts.disconnectedAt),
  )).orderBy(desc(appleRuntimeHosts.lastSeenAt)).limit(1);
  return host ?? null;
}

export async function listAppleRuntimes(db: Db, orgId: string) {
  const rows = await db.select().from(appleRuntimeHosts).where(eq(appleRuntimeHosts.orgId, orgId)).orderBy(desc(appleRuntimeHosts.lastSeenAt));
  const cutoff = Date.now() - APPLE_RUNTIME_ONLINE_WINDOW_MS;
  return rows.map((host) => ({ ...host, online: host.status === 'online' && !host.disconnectedAt && host.lastSeenAt.getTime() > cutoff }));
}

export type AppleRuntimeJobResult = {
  ok: boolean;
  xcodeVersion?: string;
  simulatorName?: string;
  macosVersion?: string;
  detail?: string;
  narrative?: string;
  changedPaths?: string[];
  buildOutput?: string;
};

export type AppleChatTurnRequest = {
  version: 1;
  runId: string;
  threadId: string;
  repoFullName: string;
  branch: string;
  emptyRepo: boolean;
  agent: 'codex' | 'claude-code';
  model: string;
  prompt: string;
};

export async function queueAppleRuntimeTest(db: Db, orgId: string) {
  const host = await availableAppleRuntime(db, orgId);
  if (!host) return null;
  const [job] = await db.insert(appleRuntimeJobs).values({
    id: ulid(), orgId, kind: 'toolchain_check', state: 'queued', request: { version: 1 },
  }).returning();
  return job ?? null;
}

export async function queueAppleChatTurn(
  db: Db, orgId: string, projectId: string, request: AppleChatTurnRequest,
) {
  const host = await availableAppleRuntime(db, orgId);
  if (!host) return null;
  const [job] = await db.insert(appleRuntimeJobs).values({
    id: ulid(), orgId, projectId, kind: 'chat_turn', state: 'queued', request,
  }).returning();
  return job ?? null;
}

export async function getAppleRuntimeJob(db: Db, orgId: string, jobId: string) {
  const [job] = await db.select().from(appleRuntimeJobs).where(and(eq(appleRuntimeJobs.orgId, orgId), eq(appleRuntimeJobs.id, jobId))).limit(1);
  return job ?? null;
}

export async function claimAppleRuntimeJob(db: Db, orgId: string, tokenId: string) {
  const host = await heartbeatAppleRuntime(db, orgId, tokenId);
  if (!host) return null;
  const [candidate] = await db.select({ id: appleRuntimeJobs.id }).from(appleRuntimeJobs)
    .where(and(eq(appleRuntimeJobs.orgId, orgId), eq(appleRuntimeJobs.state, 'queued')))
    .orderBy(asc(appleRuntimeJobs.createdAt)).limit(1);
  if (!candidate) return null;
  const [claimed] = await db.update(appleRuntimeJobs).set({ state: 'running', hostId: host.id, claimedAt: new Date() })
    .where(and(eq(appleRuntimeJobs.id, candidate.id), eq(appleRuntimeJobs.orgId, orgId), eq(appleRuntimeJobs.state, 'queued')))
    .returning();
  return claimed ?? null;
}

export async function finishAppleRuntimeJob(
  db: Db, orgId: string, tokenId: string, jobId: string, result: AppleRuntimeJobResult,
) {
  const host = await heartbeatAppleRuntime(db, orgId, tokenId);
  if (!host) return null;
  const [job] = await db.update(appleRuntimeJobs).set({
    state: result.ok ? 'succeeded' : 'failed', result, error: result.ok ? null : (result.detail ?? 'Apple runtime check failed'), finishedAt: new Date(),
  }).where(and(
    eq(appleRuntimeJobs.id, jobId), eq(appleRuntimeJobs.orgId, orgId), eq(appleRuntimeJobs.hostId, host.id), eq(appleRuntimeJobs.state, 'running'),
  )).returning();
  return job ?? null;
}

export async function assignedAppleRuntimeJob(db: Db, orgId: string, tokenId: string, jobId: string) {
  const host = await heartbeatAppleRuntime(db, orgId, tokenId);
  if (!host) return null;
  const [job] = await db.select().from(appleRuntimeJobs).where(and(
    eq(appleRuntimeJobs.id, jobId), eq(appleRuntimeJobs.orgId, orgId), eq(appleRuntimeJobs.hostId, host.id), eq(appleRuntimeJobs.state, 'running'),
  )).limit(1);
  return job ?? null;
}

export async function appleWorkspaceCheckpoint(db: Db, orgId: string, projectId: string) {
  const build = await getBuild(db, orgId, projectId);
  return build?.checkpointArchiveBase64 ? Buffer.from(build.checkpointArchiveBase64, 'base64') : null;
}

export async function storeAppleWorkspaceCheckpoint(
  db: Db, orgId: string, projectId: string, runId: string, threadId: string, agent: 'codex' | 'claude-code', archive: Buffer,
) {
  if (archive.byteLength === 0 || archive.byteLength > 25 * 1024 * 1024) throw new Error('Apple workspace checkpoint must be between 1 byte and 25 MB');
  await setBuild(db, orgId, projectId, {
    checkpointArchiveBase64: archive.toString('base64'), checkpointSha256: createHash('sha256').update(archive).digest('hex'),
    checkpointBytes: archive.byteLength, checkpointCreatedAt: new Date(), stagedChangesReady: true,
    dirtyRunId: runId, dirtyThreadId: threadId, dirtyAgent: agent, dirtyObservedAt: new Date(), sandboxId: null,
  });
}
