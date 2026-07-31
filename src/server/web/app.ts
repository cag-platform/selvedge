import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { clerkMiddleware } from '@clerk/express';
import type { Db } from '../db/client.js';
import { createGithubWebhookRouter } from '../connectors/github/webhook.js';
import { createGithubInstallRouter } from '../connectors/github/install.js';
import { ingestEvent } from '../resolution/ingest.js';
import { backfillRepoForOrg } from '../connectors/github/backfill.js';
import { buildAskDeps, buildComposeDeps, buildNarrationDeps } from '../llm/factory.js';
import { buildPushSender } from '../push/factory.js';
import { ensureOrg } from './middleware/ensureOrg.js';
import { createPacksRouter } from './routes/packs.js';
import { createProjectsRouter } from './routes/projects.js';
import { createTrayRouter } from './routes/tray.js';
import { createTodayRouter } from './routes/today.js';
import { createFeedbackRouter } from './routes/feedback.js';
import { createAdminRouter } from './routes/admin.js';
import { createOrgRouter } from './routes/org.js';
import { createDevicesRouter } from './routes/devices.js';
import { createFuelRouter } from './routes/fuel.js';
import { createConnectorsHealthRouter } from './routes/connectorsHealth.js';
import { createAskRouter } from './routes/ask.js';
import { createTrustRouter } from './routes/trust.js';
import { createMemoryRouter } from './routes/memory.js';
import { createPortabilityRouter } from './routes/portability.js';

export function createApp(db: Db, clientDir = path.resolve(process.cwd(), 'dist/client')) {
  const app = express();

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // Phase 2 voice: present only when an API key is configured; without it
  // ingestion runs the Phase 1 template path unchanged.
  const narrationDeps = buildNarrationDeps(db);
  // Push: present only when APNs is configured; without it, PUSH-routed
  // narrations are stored (and fold into the digest) but nothing is sent.
  const pushSender = buildPushSender();

  // Mounted before any JSON body parser and before Clerk: GitHub calls this
  // directly (no session), and HMAC verification needs the exact raw bytes.
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    app.use(
      createGithubWebhookRouter({
        db,
        webhookSecret,
        ingest: async (event) => {
          await ingestEvent(db, event, narrationDeps, pushSender);
        },
      }),
    );
  }

  // Clerk keys are deploy-time configuration; a fresh service must still
  // boot (healthz green, webhooks accepted) before they exist, so an
  // unconfigured deploy degrades to a clear 503 on /api instead of a
  // process crash loop.
  const clerkConfigured = Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);
  if (clerkConfigured) {
    app.use(clerkMiddleware());
  }
  app.use(express.json());

  if (!clerkConfigured) {
    console.error('CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY not set — API disabled until auth is configured');
    app.use('/api', (_req, res) => res.status(503).json({ error: 'auth not configured' }));
    app.use('/github', (_req, res) => res.status(503).json({ error: 'auth not configured' }));
  }

  // Self-guarded (checks getAuth() internally) — mounted ahead of the
  // blanket /api org guard below so its callback route, which GitHub
  // redirects the browser to, isn't forced through the same check.
  if (clerkConfigured) {
    app.use(createGithubInstallRouter({ db }));
  }

  app.use('/api', ensureOrg(db));
  app.use(createPacksRouter(db, { backfill: (orgId, repo) => backfillRepoForOrg(db, orgId, repo) }));
  app.use(createProjectsRouter(db));
  app.use(createTrayRouter(db));
  app.use(createTodayRouter(db, buildComposeDeps(db)));
  app.use(createFeedbackRouter(db));
  app.use(createAdminRouter(db));
  app.use(createOrgRouter(db));
  app.use(createDevicesRouter(db));
  app.use(createFuelRouter(db));
  app.use(createConnectorsHealthRouter(db));
  app.use(createAskRouter(db, buildAskDeps(db)));
  app.use(createTrustRouter(db));
  app.use(createMemoryRouter(db));
  app.use(createPortabilityRouter(db));

  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  // Final safety net: asyncHandler() forwards unexpected route errors here
  // via next(err) instead of leaving the client hanging (Express 4 doesn't
  // auto-forward a rejected promise the way Express 5 does).
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  };
  app.use(onError);

  return app;
}
