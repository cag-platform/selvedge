import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { connectorHealth } from '../../db/schema/index.js';

type Status = 'fresh' | 'quiet' | 'auth_failed';

async function upsert(db: Db, orgId: string, installationId: string, status: Status, meta?: string): Promise<void> {
  const now = new Date();
  await db
    .insert(connectorHealth)
    .values({
      orgId,
      connector: 'github',
      sourceAccountId: installationId,
      status,
      lastEventAt: status === 'fresh' ? now : undefined,
      updatedAt: now,
      meta,
    })
    .onConflictDoUpdate({
      target: [connectorHealth.orgId, connectorHealth.connector, connectorHealth.sourceAccountId],
      set: {
        status,
        updatedAt: now,
        ...(status === 'fresh' ? { lastEventAt: now } : {}),
        ...(meta ? { meta } : {}),
      },
    });
}

export function markInstalled(db: Db, orgId: string, installationId: string, accountLogin: string) {
  return upsert(db, orgId, installationId, 'fresh', accountLogin);
}

export function markFresh(db: Db, orgId: string, installationId: string) {
  return upsert(db, orgId, installationId, 'fresh');
}

/** Acceptance gate 6: killing the webhook secret must flip health to auth_failed. */
export function markAuthFailed(db: Db, orgId: string, installationId: string) {
  return upsert(db, orgId, installationId, 'auth_failed');
}

/** Reverse lookup: which org registered this installation? (Re-configure redirects carry no state.) */
export async function orgForInstallation(db: Db, installationId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(connectorHealth)
    .where(and(eq(connectorHealth.connector, 'github'), eq(connectorHealth.sourceAccountId, installationId)))
    .limit(1);
  return row?.orgId ?? null;
}

/** The org's GitHub installations (usually one) — newest first, auth_failed excluded. */
export async function listInstallations(db: Db, orgId: string) {
  const rows = await db
    .select()
    .from(connectorHealth)
    .where(and(eq(connectorHealth.orgId, orgId), eq(connectorHealth.connector, 'github')));
  return rows
    .filter((r) => r.status !== 'auth_failed')
    .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime());
}

export async function getHealth(db: Db, orgId: string, installationId: string) {
  const [row] = await db
    .select()
    .from(connectorHealth)
    .where(
      and(
        eq(connectorHealth.orgId, orgId),
        eq(connectorHealth.connector, 'github'),
        eq(connectorHealth.sourceAccountId, installationId),
      ),
    )
    .limit(1);
  return row ?? null;
}
