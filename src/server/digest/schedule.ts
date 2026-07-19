import type { Db } from '../db/client.js';
import { orgs } from '../db/schema/index.js';
import { composeDigestForOrg } from './compose.js';
import type { ComposeLlmDeps } from './composeLlm.js';
import { localDateString } from './timezone.js';

/**
 * Runs on a periodic tick (jobs/cron.ts, every 15 min). composeDigestForOrg
 * is idempotent per (org, local calendar day), so any org whose local time
 * currently falls in the 7:00 hour gets composed — harmless to call
 * repeatedly through the hour, since only the first call in a given day
 * actually writes a row.
 */
export async function runDigestSchedule(db: Db, now: Date = new Date(), llmDeps?: ComposeLlmDeps): Promise<string[]> {
  const allOrgs = await db.select({ orgId: orgs.orgId, timezone: orgs.timezone }).from(orgs);
  const composedFor: string[] = [];

  for (const org of allOrgs) {
    const hour = localHour(now, org.timezone);
    if (hour === 7) {
      await composeDigestForOrg(db, org.orgId, now, llmDeps);
      composedFor.push(org.orgId);
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
