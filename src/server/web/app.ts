import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { clerkMiddleware } from '@clerk/express';
import type { Db } from '../db/client.js';
import { createGithubWebhookRouter } from '../connectors/github/webhook.js';
import { createGithubInstallRouter } from '../connectors/github/install.js';
import { ingestEvent } from '../resolution/ingest.js';
import { buildNarrationDeps } from '../llm/factory.js';
import { ensureOrg } from './middleware/ensureOrg.js';
import { createPacksRouter } from './routes/packs.js';
import { createProjectsRouter } from './routes/projects.js';
import { createTrayRouter } from './routes/tray.js';
import { createTodayRouter } from './routes/today.js';
import { createFeedbackRouter } from './routes/feedback.js';

export function createApp(db: Db, clientDir = path.resolve(process.cwd(), 'dist/client')) {
  const app = express();

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // Phase 2 voice: present only when an API key is configured; without it
  // ingestion runs the Phase 1 template path unchanged.
  const narrationDeps = buildNarrationDeps(db);

  // Mounted before any JSON body parser and before Clerk: GitHub calls this
  // directly (no session), and HMAC verification needs the exact raw bytes.
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    app.use(
      createGithubWebhookRouter({
        db,
        webhookSecret,
        ingest: async (event) => {
          await ingestEvent(db, event, narrationDeps);
        },
      }),
    );
  }

  app.use(clerkMiddleware());
  app.use(express.json());

  // Self-guarded (checks getAuth() internally) — mounted ahead of the
  // blanket /api org guard below so its callback route, which GitHub
  // redirects the browser to, isn't forced through the same check.
  app.use(createGithubInstallRouter({ db }));

  app.use('/api', ensureOrg(db));
  app.use(createPacksRouter(db));
  app.use(createProjectsRouter(db));
  app.use(createTrayRouter(db));
  app.use(createTodayRouter(db));
  app.use(createFeedbackRouter(db));

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
