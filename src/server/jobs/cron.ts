import cron from 'node-cron';
import type { Db } from '../db/client.js';
import { runDigestSchedule } from '../digest/schedule.js';
import { buildComposeDeps } from '../llm/factory.js';
import { buildPushSender } from '../push/factory.js';
import { runStallSweep } from '../resolution/stallSweep.js';
import { sweepOAuthStates } from '../connectors/oauthState.js';
import { revalidateBaselines } from '../memory/revalidate.js';
import { ensureCurrentPartitions } from '../db/partitions.js';
import { pollHealth, newMonitorState } from '../monitor/poller.js';
import { makePollerIngest, listHealthChecksToPoll } from '../monitor/wiring.js';
import { pollDeployStates } from '../connectors/host/poller.js';
import { listDeployServicesToPoll } from '../connectors/host/wiring.js';
import type { HostDeployStatus } from '../connectors/host/deploy.js';
import { sweepStagedUploads } from '../build/uploads.js';
import { runSandboxReconciliation, runSandboxSweep } from '../build/reaper.js';
import { sweepHostedPreviews } from '../build/preview.js';

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

  /**
   * THE SANDBOX SWEEP — every minute, and the reason infra cost is predictable.
   *
   * Daytona bills wall-clock time and is roughly three quarters of what this
   * product costs to run, so the expensive failure is not a sandbox that runs
   * too long — it is one that finished and stayed up. This closes those within
   * a minute of the work ending, and meters what they used.
   *
   * It reads `sandbox_runs` rather than any in-process state, which is what
   * makes it survive a restart: a deploy in the middle of a build leaves a
   * sandbox running and a row open, and the next tick after boot finds it.
   *
   * Only fired where Daytona is actually configured — on a deployment without
   * it there is nothing to sweep and the API calls would just log failures.
   */
  if (process.env.OPENAI_API_KEY && process.env.PREVIEW_RELAY_SIGNING_SECRET) {
    cron.schedule('* * * * *', () => {
      runSandboxSweep(db).catch((err) => console.error('sandbox sweep failed:', err));
    });
  }
  cron.schedule('* * * * *', () => {
    sweepHostedPreviews(db).catch((err) => console.error('hosted preview sweep failed:', err));
  });

  cron.schedule('0 3 * * *', () => {
    runStallSweep(db).catch((err) => console.error('stall sweep failed:', err));
    // The no-silent-leak check: what Daytona says it is running, against what
    // we think. Anything it is running that we have no row for is money leaving
    // with nothing to attribute it to.
    if (process.env.OPENAI_API_KEY && process.env.PREVIEW_RELAY_SIGNING_SECRET) {
      runSandboxReconciliation(db)
        .then(({ strays, ghosts }) => {
          if (strays.length || ghosts.length) {
            console.error(`sandbox reconciliation: ${strays.length} unaccounted-for running, ${ghosts.length} gone without a stop`);
          }
        })
        .catch((err) => console.error('sandbox reconciliation failed:', err));
    }
    // Handshakes nobody came back from. Consumed states delete themselves; this
    // is only for the owner who closed the popup.
    sweepOAuthStates(db).catch((err) => console.error('oauth state sweep failed:', err));
    ensureCurrentPartitions(db).catch((err) => console.error('ensureCurrentPartitions failed:', err));
    // Anti-rot: keep learned baselines tracking reality (Ironclad 1).
    revalidateBaselines(db).catch((err) => console.error('revalidateBaselines failed:', err));
  });

  // Disk-safety backstop: a Workshop file attached but never sent (or a
  // redeploy landed between "attach" and "send") is deleted after 30 idle
  // minutes rather than left on disk.
  cron.schedule('*/15 * * * *', () => {
    sweepStagedUploads().catch((err) => console.error('staged upload sweep failed:', err));
  });
}
