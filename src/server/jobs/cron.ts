import cron from 'node-cron';
import type { Db } from '../db/client.js';
import { runDigestSchedule } from '../digest/schedule.js';
import { buildComposeDeps } from '../llm/factory.js';
import { buildPushSender } from '../push/factory.js';
import { runStallSweep } from '../resolution/stallSweep.js';
import { revalidateBaselines } from '../memory/revalidate.js';
import { ensureCurrentPartitions } from '../db/partitions.js';

/**
 * Every 15 minutes: compose the digest for any org whose local time is in
 * the 7:00 hour (composeDigestForOrg is idempotent, so this is safe to
 * over-fire). Every 24h: sweep for stalled in_progress items and make sure
 * next month's events partition exists ahead of need.
 */
export function startCronJobs(db: Db): void {
  // Per-org fuel resolution happens inside the schedule loop.
  const pushSender = buildPushSender();
  cron.schedule('*/15 * * * *', () => {
    runDigestSchedule(db, new Date(), (orgId) => buildComposeDeps(db, orgId), pushSender).catch((err) => console.error('digest schedule failed:', err));
  });

  cron.schedule('0 3 * * *', () => {
    runStallSweep(db).catch((err) => console.error('stall sweep failed:', err));
    ensureCurrentPartitions(db).catch((err) => console.error('ensureCurrentPartitions failed:', err));
    // Anti-rot: keep learned baselines tracking reality (Ironclad 1).
    revalidateBaselines(db).catch((err) => console.error('revalidateBaselines failed:', err));
  });
}
