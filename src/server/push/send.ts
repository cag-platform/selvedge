import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devices } from '../db/schema/index.js';
import type { PushNotification, PushSender } from './types.js';

export type PushSendSummary = { sent: number; failed: number; pruned: number };

/**
 * Send one notification to every device registered for an org, and prune any
 * token APNs reports as unregistered (410). This is the one place the
 * `devices` table is read for delivery.
 */
export async function sendToOrgDevices(
  db: Db,
  orgId: string,
  sender: PushSender,
  notification: PushNotification,
): Promise<PushSendSummary> {
  const rows = await db.select().from(devices).where(eq(devices.orgId, orgId));
  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const row of rows) {
    const outcome = await sender.send(row.token, row.environment, notification);
    if (outcome.ok) sent++;
    else failed++;
    if (outcome.unregistered) {
      await db.delete(devices).where(and(eq(devices.orgId, orgId), eq(devices.token, row.token)));
      pruned++;
    }
  }

  return { sent, failed, pruned };
}
