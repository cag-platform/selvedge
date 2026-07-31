import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests, orgs } from '../db/schema/index.js';
import { composeDigestForOrg } from './compose.js';
import type { ComposeDepsResolver } from '../llm/factory.js';
import { localDateString } from './timezone.js';
import type { PushSender } from '../push/types.js';
import { sendToOrgDevices } from '../push/send.js';
import { morningBriefNotification } from '../push/notifications.js';

/**
 * Runs on a periodic tick (jobs/cron.ts, every 15 min). composeDigestForOrg
 * is idempotent per (org, local calendar day), so any org whose local time
 * currently falls in the 7:00 hour gets composed — harmless to call
 * repeatedly through the hour, since only the first call in a given day
 * actually writes a row.
 */
export async function runDigestSchedule(
  db: Db,
  now: Date = new Date(),
  resolveComposeDeps?: ComposeDepsResolver,
  pushSender?: PushSender,
): Promise<string[]> {
  const allOrgs = await db.select({ orgId: orgs.orgId, timezone: orgs.timezone }).from(orgs);
  const composedFor: string[] = [];

  for (const org of allOrgs) {
    const hour = localHour(now, org.timezone);
    if (hour !== 7) continue;

    // The morning brief pushes exactly once per org per day: only when this
    // tick is the one that actually composes it (compose is idempotent, but
    // the send must not be — check existence before composing).
    const todayStr = localDateString(now, org.timezone);
    const [existing] = await db
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.orgId, org.orgId), eq(digests.digestDate, todayStr)))
      .limit(1);

    // Each org's brief composes on that org's own fuel, resolved here in the
    // loop — a BYO org's daily brief runs on its own key.
    const llmDeps = resolveComposeDeps ? await resolveComposeDeps(org.orgId) : undefined;
    const digest = await composeDigestForOrg(db, org.orgId, now, llmDeps);
    composedFor.push(org.orgId);

    if (!existing && pushSender) {
      await sendToOrgDevices(db, org.orgId, pushSender, morningBriefNotification(digest)).catch((err) =>
        console.error(`morning push failed for org ${org.orgId}:`, err),
      );
    }
  }
  return composedFor;
}

function localHour(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hour12: false });
  const hourStr = formatter.formatToParts(now).find((p) => p.type === 'hour')?.value ?? '0';
  return Number(hourStr) % 24;
}

export { localDateString };
