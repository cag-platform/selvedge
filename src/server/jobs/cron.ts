import cron from 'node-cron';
import type { Db } from '../db/client.js';
import { runDigestSchedule } from '../digest/schedule.js';
import { runStallSweep } from '../resolution/stallSweep.js';
import { ensureCurrentPartitions } from '../db/partitions.js';

/**
 * Every 15 minutes: compose the digest for any org whose local time is in
 * the 7:00 hour (composeDigestForOrg is idempotent, so this is safe to
 * over-fire). Every 24h: sweep for stalled in_progress items and make sure
 * next month's events partition exists ahead of need.
 */
export function startCronJobs(db: Db): void {
  cron.schedule('*/15 * * * *', () => {
    runDigestSchedule(db).catch((err) => console.error('digest schedule failed:', err));
  });

  cron.schedule('0 3 * * *', () => {
    runStallSweep(db).catch((err) => console.error('stall sweep failed:', err));
    ensureCurrentPartitions(db).catch((err) => console.error('ensureCurrentPartitions failed:', err));
  });
}
