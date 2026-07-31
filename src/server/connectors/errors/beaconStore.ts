import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { projectBeacons, errorRateState } from '../../db/schema/index.js';
import { FRESH, type ErrorRateState } from '../../monitor/errorRate.js';

/**
 * The beacon store. Two secrets-adjacent disciplines, borrowed from the
 * credentials vault:
 *
 *   1. The token is shown exactly once, at issue. Only its SHA-256 hash is
 *      stored, so a database read can never recover a working beacon token.
 *   2. Reconnecting replaces, never accumulates: re-issuing a project's beacon
 *      overwrites the old hash, instantly invalidating the previous token.
 *
 * Auth is a reverse lookup by hash — the endpoint hashes the presented token
 * and finds the (org, project) it belongs to, or nothing.
 */

const TOKEN_PREFIX = 'sbk_'; // selvedge beacon key

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue (or rotate) a project's beacon token. Returns the plaintext token ONCE;
 * it is never retrievable again. The caller shows it to the owner and stores
 * nothing.
 */
export async function issueBeacon(db: Db, orgId: string, projectId: string): Promise<string> {
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  await db
    .insert(projectBeacons)
    .values({ orgId, projectId, tokenHash })
    .onConflictDoUpdate({
      target: [projectBeacons.orgId, projectBeacons.projectId],
      set: { tokenHash, createdAt: new Date(), lastSeenAt: null },
    });
  return token;
}

/** Resolve a presented token to its (org, project), or null. Never throws. */
export async function resolveBeacon(db: Db, token: string): Promise<{ orgId: string; projectId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({ orgId: projectBeacons.orgId, projectId: projectBeacons.projectId })
    .from(projectBeacons)
    .where(eq(projectBeacons.tokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

/** Note that a beacon was just used, for the "last reported" display. */
export async function touchBeacon(db: Db, orgId: string, projectId: string): Promise<void> {
  await db
    .update(projectBeacons)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(projectBeacons.orgId, orgId), eq(projectBeacons.projectId, projectId)));
}

/** Whether a project has a beacon issued (for the display; never returns a token). */
export async function beaconStatus(
  db: Db,
  orgId: string,
  projectId: string,
): Promise<{ issued: boolean; lastSeenAt: Date | null }> {
  const [row] = await db
    .select({ lastSeenAt: projectBeacons.lastSeenAt })
    .from(projectBeacons)
    .where(and(eq(projectBeacons.orgId, orgId), eq(projectBeacons.projectId, projectId)))
    .limit(1);
  return { issued: Boolean(row), lastSeenAt: row?.lastSeenAt ?? null };
}

/** Revoke a project's beacon (delete). The token stops working immediately. */
export async function revokeBeacon(db: Db, orgId: string, projectId: string): Promise<boolean> {
  const deleted = await db
    .delete(projectBeacons)
    .where(and(eq(projectBeacons.orgId, orgId), eq(projectBeacons.projectId, projectId)))
    .returning({ projectId: projectBeacons.projectId });
  return deleted.length > 0;
}

/** Load the persisted detector state for an error stream, or FRESH if none yet. */
export async function loadErrorState(db: Db, orgId: string, projectId: string, sourceId: string): Promise<ErrorRateState> {
  const [row] = await db
    .select()
    .from(errorRateState)
    .where(and(eq(errorRateState.orgId, orgId), eq(errorRateState.projectId, projectId), eq(errorRateState.sourceId, sourceId)))
    .limit(1);
  if (!row) return FRESH;
  return {
    baseline: row.baseline,
    windowsSeen: row.windowsSeen,
    consecutiveElevated: row.consecutiveElevated,
    alerted: row.alerted,
  };
}

/** Persist the detector state after a window. */
export async function saveErrorState(
  db: Db,
  orgId: string,
  projectId: string,
  sourceId: string,
  state: ErrorRateState,
): Promise<void> {
  await db
    .insert(errorRateState)
    .values({
      orgId,
      projectId,
      sourceId,
      baseline: state.baseline,
      windowsSeen: state.windowsSeen,
      consecutiveElevated: state.consecutiveElevated,
      alerted: state.alerted,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [errorRateState.orgId, errorRateState.projectId, errorRateState.sourceId],
      set: {
        baseline: state.baseline,
        windowsSeen: state.windowsSeen,
        consecutiveElevated: state.consecutiveElevated,
        alerted: state.alerted,
        updatedAt: new Date(),
      },
    });
}
