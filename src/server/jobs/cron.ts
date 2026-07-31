import cron from 'node-cron';
import type { Db } from '../db/client.js';
import { runDigestSchedule } from '../digest/schedule.js';
import { buildComposeDeps } from '../llm/factory.js';
import { buildPushSender } from '../push/factory.js';
import { runStallSweep } from '../resolution/stallSweep.js';
import { revalidateBaselines } from '../memory/revalidate.js';
import { ensureCurrentPartitions } from '../db/partitions.js';
import { pollHealth, newMonitorState } from '../monitor/poller.js';
import { makePollerIngest, listHealthChecksToPoll } from '../monitor/wiring.js';
import { pollDeployStates } from '../connectors/railway/poller.js';
import { listDeployServicesToPoll } from '../connectors/railway/wiring.js';
import type { HostDeployStatus } from '../connectors/railway/client.js';

/**
 * Every 15 minutes: compose the digest for any org whose local time is in
 * the 7:00 hour (composeDigestForOrg is idempotent, so this is safe to
 * over-fire). Every minute: poll health checks (each check runs on its own
 * interval; the tick just gives them a chance). Every 24h: sweep for stalled
 * in_progress items and make sure next month's events partition exists.
 */
export function startCronJobs(db: Db): void {
  // Per-org fuel resolution happens inside the schedule loop.
  const pushSender = buildPushSender();
  cron.schedule('*/15 * * * *', () => {
    runDigestSchedule(db, new Date(), (orgId) => buildComposeDeps(db, orgId), pushSender).catch((err) => console.error('digest schedule failed:', err));
  });

  // The health monitor. State is held across ticks (in-process, single-process
  // tradeoff); each check still only runs when its own interval has elapsed.
  const monitorState = newMonitorState();
  const pollerIngest = makePollerIngest(db);
  cron.schedule('* * * * *', () => {
    pollHealth({
      db,
      state: monitorState,
      listChecks: () => listHealthChecksToPoll(db),
      ingest: pollerIngest,
    }).catch((err) => console.error('health poll failed:', err));
  });

  // The Railway deploy poller, sharing the same ingest sink. Its last-known
  // state per service is held across ticks here (in-process, single-process
  // tradeoff); a service the customer hasn't connected a Railway token for is
  // simply not in the list this tick.
  const deployState = new Map<string, HostDeployStatus>();
  cron.schedule('* * * * *', () => {
    pollDeployStates({
      db,
      lastState: deployState,
      listServices: () => listDeployServicesToPoll(db),
      ingest: pollerIngest,
    }).catch((err) => console.error('deploy poll failed:', err));
  });

  cron.schedule('0 3 * * *', () => {
    runStallSweep(db).catch((err) => console.error('stall sweep failed:', err));
    ensureCurrentPartitions(db).catch((err) => console.error('ensureCurrentPartitions failed:', err));
    // Anti-rot: keep learned baselines tracking reality (Ironclad 1).
    revalidateBaselines(db).catch((err) => console.error('revalidateBaselines failed:', err));
  });
}
