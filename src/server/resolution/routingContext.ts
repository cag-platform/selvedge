import { and, eq, gte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { narrations, orgs } from '../db/schema/index.js';

const STORM_WINDOW_MINUTES = 15;

/** Project-local "HH:MM" (24h) for the org's configured timezone, at `now`. */
export async function currentLocalTime(db: Db, orgId: string, now: Date): Promise<string> {
  const [row] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  const timeZone = row?.timezone ?? 'UTC';
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  return formatter.format(now); // "HH:MM"
}

/** Push-worthy narrations already routed for this project in the trailing 15 minutes. */
export async function recentPushWorthyCount(db: Db, orgId: string, projectId: string, now: Date): Promise<number> {
  const windowStart = new Date(now.getTime() - STORM_WINDOW_MINUTES * 60 * 1000);
  const rows = await db
    .select({ id: narrations.id })
    .from(narrations)
    .where(
      and(
        eq(narrations.orgId, orgId),
        eq(narrations.projectId, projectId),
        eq(narrations.delivery, 'PUSH'),
        gte(narrations.occurredAt, windowStart),
      ),
    );
  return rows.length;
}

/** Did the most recent runtime.health_failing narration for this project push? (C2's "recovery pushes iff the outage pushed".) */
export async function pairedOutagePushed(db: Db, orgId: string, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ delivery: narrations.delivery })
    .from(narrations)
    .where(and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId), eq(narrations.eventType, 'runtime.health_failing')))
    .orderBy(narrations.occurredAt)
    .limit(1000); // Phase 1 volumes are tiny; simplest correct approach over a hand-rolled "latest" query.

  const last = rows.at(-1);
  return last?.delivery === 'PUSH';
}
