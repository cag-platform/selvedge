import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { clerkMiddleware } from '@clerk/express';
import type { Db } from '../db/client.js';
import { getPreviewProxy } from './previewProxy.js';
import { createGithubWebhookRouter } from '../connectors/github/webhook.js';
import { createGithubInstallRouter } from '../connectors/github/install.js';
import { createErrorBeaconRouter } from '../connectors/errors/beacon.js';
import { makePollerIngest } from '../monitor/wiring.js';
import { ingestEvent } from '../resolution/ingest.js';
import { backfillRepoForOrg } from '../connectors/github/backfill.js';
import { createNewRepo } from '../connectors/github/newRepo.js';
import { buildAskDeps, buildComposeDeps, buildNarrationDeps, buildSketchDeps } from '../llm/factory.js';
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
import { createHostsRouter } from './routes/hosts.js';
import { createGithubSetupRouter } from './routes/githubSetup.js';
import { createRailwaySetupRouter } from './routes/railwaySetup.js';
import { createProtectionRouter } from './routes/protection.js';
import { createConnectorsHealthRouter } from './routes/connectorsHealth.js';
import { createAskRouter } from './routes/ask.js';
import { createTrustRouter } from './routes/trust.js';
import { createMemoryRouter } from './routes/memory.js';
import { createPortabilityRouter } from './routes/portability.js';
import { createBeaconRouter } from './routes/beacon.js';
import { createCardsRouter } from './routes/cards.js';
import { createLedgerRouter } from './routes/ledger.js';
import { createWorkshopRouter, startWorkshopTurn } from './routes/workshop.js';
import { createSketchRouter } from './routes/sketch.js';
import { buildBuildEngine } from '../runner/daytona/factory.js';
import { driveCard } from '../cards/drive.js';

export function createApp(db: Db, clientDir = path.resolve(process.cwd(), 'dist/client')) {
  const app = express();

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // The preview proxy: host-scoped (only *.PREVIEW_DOMAIN requests), mounted
  // before everything so preview traffic never touches auth or body parsing.
  // Inert when PREVIEW_DOMAIN is unset.
  app.use(getPreviewProxy(db).middleware);

  // Phase 2 voice: present only when an API key is configured; without it
  // ingestion runs the Phase 1 template path unchanged.
  // Narration deps are resolved PER EVENT below, from the event's org fuel —
  // no single startup client. An org with no fuel gets the template path.
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
          const narrationDeps = await buildNarrationDeps(db, event.org_id ?? '');
          await ingestEvent(db, event, narrationDeps, pushSender);
        },
      }),
    );
  }

  // The error beacon receiver: no session (the beacon token is the auth), so
  // it's mounted before Clerk alongside the GitHub webhook. It shares the same
  // (event, projectId) ingest sink the pollers use.
  const beaconIngest = makePollerIngest(db);
  app.use(createErrorBeaconRouter({ db, ingest: beaconIngest }));

  // Workshop messages can carry attached screenshots/files (base64 in the JSON
  // body), which don't fit the default 100kb body limit. A dedicated parser on
  // just this path, mounted before the general one below, covers that; the
  // general parser sees the body already set and skips re-parsing it.
  app.use('/api/projects/:projectId/workshop/message', express.json({ limit: '100mb' }));

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
  app.use(
    createPacksRouter(db, {
      backfill: (orgId, repo) => backfillRepoForOrg(db, orgId, repo),
      // Start-from-nothing projects can mint their own private repo, but only
      // when the build engine's GitHub token is around to do it.
      ...(process.env.GITHUB_TOKEN ? { createRepo: createNewRepo } : {}),
    }),
  );
  app.use(createProjectsRouter(db));
  app.use(createTrayRouter(db));
  app.use(createTodayRouter(db, (orgId) => buildComposeDeps(db, orgId)));
  app.use(createFeedbackRouter(db));
  app.use(createAdminRouter(db));
  app.use(createOrgRouter(db));
  app.use(createDevicesRouter(db));
  app.use(createFuelRouter(db));
  app.use(createHostsRouter(db));
  app.use(createGithubSetupRouter(db, { redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI }));
  // "Login with Railway" — self-guarding: it answers with a plain 503 pointing
  // at the paste-a-token path when the OAuth app isn't registered yet.
  app.use(createRailwaySetupRouter(db));
  app.use(createProtectionRouter(db));
  app.use(createConnectorsHealthRouter(db));
  app.use(createAskRouter(db, (orgId) => buildAskDeps(db, orgId)));
  // Sketch: think an idea through cheaply, then hand the brief to the workshop.
  app.use(
    createSketchRouter(db, {
      resolveDeps: (orgId) => buildSketchDeps(db, orgId),
      handOff: (orgId, projectId, text) => startWorkshopTurn(db, orgId, projectId, text),
    }),
  );
  app.use(createTrustRouter(db));
  app.use(createMemoryRouter(db));
  app.use(createPortabilityRouter(db));
  app.use(createBeaconRouter(db));
  // The build engine — present only when Daytona + the Claude token + a GitHub
  // token are all configured. When present, approving a card hands it off to run
  // (in the background; the run takes minutes and the cap guards the spend). When
  // absent, an approved card simply waits — no inert half-run.
  const engine = buildBuildEngine(db);
  const onRunnable = engine
    ? (orgId: string, cardId: string) => {
        void driveCard(db, orgId, cardId, engine).catch((err) => console.error(`card drive failed for ${cardId}:`, err));
      }
    : undefined;
  app.use(createCardsRouter(db, onRunnable ? { onRunnable } : {}));
  app.use(createLedgerRouter(db));
  app.use(createWorkshopRouter(db));

  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  // Final safety net: asyncHandler() forwards unexpected route errors here
  // via next(err) instead of leaving the client hanging (Express 4 doesn't
  // auto-forward a rejected promise the way Express 5 does).
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    // A reference id ties what the owner sees to the exact log line, so an
    // "internal error" report (even a screenshot) is diagnosable.
    const ref = Math.random().toString(36).slice(2, 8);
    console.error(`[err ${ref}] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: `internal error (ref ${ref})` });
  };
  app.use(onError);

  return app;
}
