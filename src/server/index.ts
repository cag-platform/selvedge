import { db } from './db/client.js';
import { createApp } from './web/app.js';
import { startCronJobs } from './jobs/cron.js';
import { validateEnv, envReportLines } from './config/env.js';
import { getPreviewRelay } from './workspace/relay/factory.js';

// The credential contract, enforced at boot. A missing boot-critical credential
// (the database, the vault key) stops the process with a clear message rather
// than failing obscurely on the first request. Everything else degrades
// gracefully — its absence is logged plainly, and the feature is simply off.
const report = validateEnv();
const notes = envReportLines(report);
if (notes.length > 0) {
  console.log('Selvedge configuration:');
  for (const line of notes) console.log(line);
}
if (!report.ok) {
  console.error('Cannot start: a required credential is missing (see above). Set it and restart.');
  process.exit(1);
}

const app = createApp(db);
// Cost-safe development mode keeps the web app available without waking the
// database every minute. Background monitoring and cleanup are opt-in again by
// setting BACKGROUND_JOBS_ENABLED=true when Selvedge is ready for continuous
// production operation.
if (process.env.BACKGROUND_JOBS_ENABLED === 'true') {
  startCronJobs(db);
} else {
  console.log('Background jobs are off (set BACKGROUND_JOBS_ENABLED=true to enable them).');
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Selvedge listening on :${port}`);
});
// Development Workspaces connect outbound to Selvedge's Preview Relay.
const workspaceRelay = getPreviewRelay();
if (workspaceRelay) server.on('upgrade', workspaceRelay.web.upgrade);
