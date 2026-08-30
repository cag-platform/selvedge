import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { appleRuntimeHosts } from '../db/schema/index.js';

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
