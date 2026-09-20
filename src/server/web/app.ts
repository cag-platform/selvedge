import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { clerkMiddleware } from '@clerk/express';
import type { Db } from '../db/client.js';
import { createGithubWebhookRouter } from '../connectors/github/webhook.js';
import { createGithubInstallRouter } from '../connectors/github/install.js';
import { createErrorBeaconRouter } from '../connectors/errors/beacon.js';
import { makePollerIngest } from '../monitor/wiring.js';
import { ingestEvent } from '../resolution/ingest.js';
import { backfillRepoForOrg } from '../connectors/github/backfill.js';
import { createNewRepo } from '../connectors/github/newRepo.js';
import { buildComposeDeps, buildNarrationDeps } from '../llm/factory.js';
import { buildPushSender } from '../push/factory.js';
import { ensureOrg } from './middleware/ensureOrg.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { sameOriginGuard } from './middleware/sameOrigin.js';
import { publicLimiter, pairingLimiter, sensitiveLimiter, uploadLimiter } from './middleware/rateLimit.js';
import { createPacksRouter } from './routes/packs.js';
import { createProjectsRouter } from './routes/projects.js';
import { createBillingRouter } from './routes/billing.js';
import { createStripeWebhookRouter } from './routes/stripeWebhook.js';
import { createTrayRouter } from './routes/tray.js';
import { createStatusRouter } from './routes/status.js';
import { createTodayRouter } from './routes/today.js';
import { createFeedbackRouter } from './routes/feedback.js';
import { createAdminRouter } from './routes/admin.js';
import { createOrgRouter } from './routes/org.js';
import { createDevicesRouter } from './routes/devices.js';
import { createFuelRouter } from './routes/fuel.js';
import { createAgentConnectionsRouter } from './routes/agentConnections.js';
import { createHostsRouter } from './routes/hosts.js';
import { createGithubSetupRouter } from './routes/githubSetup.js';
import { createRailwaySetupRouter } from './routes/railwaySetup.js';
import { createProtectionRouter } from './routes/protection.js';
import { createConnectorsHealthRouter } from './routes/connectorsHealth.js';
import { createTrustRouter } from './routes/trust.js';
import { createMemoryRouter } from './routes/memory.js';
import { createPortabilityRouter } from './routes/portability.js';
import { createBeaconRouter } from './routes/beacon.js';
import { createCardsRouter } from './routes/cards.js';
import { createLedgerRouter } from './routes/ledger.js';
import { createWorkshopRouter } from './routes/workshop.js';
import { createThreadsRouter } from './routes/threads.js';
import { createTimelineRouter } from './routes/timeline.js';
import { createSubjectsRouter } from './routes/subjects.js';
import { createImportHistoryRouter } from './routes/importHistory.js';
import { createImportReplitRouter } from './routes/importReplit.js';
import { createGithubArrivalRouter } from './routes/githubArrival.js';
import { createDecisionsRouter } from './routes/decisions.js';
import { createCompanionRouter } from './routes/companion.js';
import { createCompanionKeysRouter } from './routes/companionKeys.js';
import { createContinuationsRouter } from './routes/continuations.js';
import { createDistributionOpsRouter } from './routes/distributionOps.js';
import { buildBuildEngine } from '../runner/native/factory.js';
import { driveCard } from '../cards/drive.js';
import { getPreviewRelay } from '../workspace/relay/factory.js';
import { companionInstaller } from '../companion/installer.js';

export function createApp(db: Db, clientDir = path.resolve(process.cwd(), 'dist/client')) {
  const app = express();
  // Railway terminates TLS before forwarding to Express. Trust exactly that
  // first proxy so req.protocol remains https for security-sensitive links
  // such as Mac device authorization, without trusting arbitrary proxy chains.
  app.set('trust proxy', 1);

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
  // The installer script embeds the origin the CLI then curls a binary from.
  // Deriving it from the Host header lets an attacker point a victim's install
  // at their own domain — over the product's own TLS — so in production the
  // origin MUST come from PUBLIC_ORIGIN. Dev (localhost) still falls back.
  app.get('/install-companion', publicLimiter(), (req, res) => {
    const configured = process.env.PUBLIC_ORIGIN?.trim();
    if (!configured) {
      if (process.env.NODE_ENV === 'production') {
        res.status(503).type('text/plain').send('# Installer unavailable: PUBLIC_ORIGIN is not configured on the server.\n');
        return;
      }
      res.type('text/x-shellscript').send(companionInstaller(`${req.protocol}://${req.get('host')}`));
      return;
    }
    res.type('text/x-shellscript').send(companionInstaller(configured));
  });

  // Selvedge-native workspace previews. The customer app connects OUT to this
  // relay; browsers never receive a provider URL or workspace credential.
  // Mounted before Clerk/body parsing because the signed viewer capability and
  // connector capability are the authentication for these two narrow paths.
  // It sets its OWN (stricter, sandboxed) headers per response, so it is mounted
  // ahead of the product security-header middleware and never inherits it.
  const workspaceRelay = getPreviewRelay();
  if (workspaceRelay) app.use(workspaceRelay.web.router);

  // Every non-preview response carries the product security headers.
  app.use(securityHeaders());

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
  app.use('/beacons', publicLimiter());
  app.use(createErrorBeaconRouter({ db, ingest: beaconIngest }));

  // STRIPE'S WEBHOOK, MOUNTED HERE AND NOWHERE ELSE.
  //
  // Two things about this position are load-bearing. It is ahead of
  // express.json() because the signature is computed over the exact bytes
  // Stripe sent, and a body that has been parsed and re-serialised will not
  // verify. And it is ahead of the /api org guard because Stripe has no
  // session — the signature IS the authentication, which is why the route
  // refuses anything it cannot verify and reads nothing before it does.
  app.use(createStripeWebhookRouter(db));

  // Clerk keys are deploy-time configuration; a fresh service must still
  // boot (healthz green, webhooks accepted) before they exist, so an
  // unconfigured deploy degrades to a clear 503 on /api instead of a
  // process crash loop.
  const clerkConfigured = Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);
  if (clerkConfigured) {
    app.use(clerkMiddleware());
  }

  // LARGE-BODY PARSERS SIT BEHIND CLERK AND A RATE LIMIT.
  //
  // These used to run ahead of clerkMiddleware, so an anonymous client could
  // make the process buffer and parse up to 100 MB before its 401. Now Clerk
  // has populated the session first, the per-org limiter bounds how often even
  // an authed caller can push a big body, and each parser still precedes the
  // general 100 kb one below (which then sees the body set and skips it).
  // Workshop/Inbox messages carry inline base64 screenshots; the companion
  // import batches conversations; the apple archive is a raw upload.
  app.use('/api/projects/:projectId/workshop/message', sensitiveLimiter(), express.json({ limit: '100mb' }));
  app.use('/api/threads/:threadId/message', sensitiveLimiter(), express.json({ limit: '100mb' }));
  app.use('/api/companion/import/conversations', sensitiveLimiter(), express.json({ limit: '25mb' }));
  app.use('/api/companion/runtime/apple/jobs/:jobId/archive', sensitiveLimiter(), express.raw({ type: 'application/octet-stream', limit: '25mb' }));

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

  // The companion's door — a bearer key issued to one machine, not a person
  // with a session, so it is mounted ahead of the Clerk org guard and does its
  // own scoping. Pairing CREATION is unauthenticated, so bound it (the polled
  // status GET passes through untouched).
  app.use('/api/companion/pairings', pairingLimiter());
  app.use(createCompanionRouter(db));

  // CSRF defense in depth: refuse a mutating /api call that carries a
  // cross-site Origin. Placed after the companion router (bearer-auth, no
  // Origin) so the CLI is unaffected.
  app.use('/api', sameOriginGuard());
  app.use('/api', ensureOrg(db));
  app.use(
    createPacksRouter(db, {
      backfill: (orgId, repo) => backfillRepoForOrg(db, orgId, repo),
      createRepo: (orgId, name, description) => createNewRepo(db, orgId, name, description),
    }),
  );
  app.use(createBillingRouter(db));
  app.use(createProjectsRouter(db));
  app.use(createTrayRouter(db, { backfill: (orgId, repo) => backfillRepoForOrg(db, orgId, repo) }));
  app.use(createTodayRouter(db, (orgId) => buildComposeDeps(db, orgId)));
  app.use(createStatusRouter(db));
  app.use(createFeedbackRouter(db));
  app.use(createAdminRouter(db));
  app.use(createDistributionOpsRouter(db));
  app.use(createOrgRouter(db));
  app.use(createDevicesRouter(db));
  // Provider-key verification pings an external API with a pasted key — an
  // abuse/oracle vector — so bound the POST (the connect UI's status GET polls).
  app.use('/api/fuel', sensitiveLimiter());
  app.use(createFuelRouter(db));
  app.use(createAgentConnectionsRouter(db));
  app.use(createHostsRouter(db));
  app.use(createGithubSetupRouter(db, { redirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI }));
  // "Login with Railway" — self-guarding: it answers with a plain 503 pointing
  // at the paste-a-token path when the OAuth app isn't registered yet.
  app.use(createRailwaySetupRouter(db));
  app.use(createProtectionRouter(db));
  app.use(createConnectorsHealthRouter(db));
  app.use(createTrustRouter(db));
  app.use(createMemoryRouter(db));
  app.use(createPortabilityRouter(db));
  app.use(createBeaconRouter(db));
  // The build engine — present only when the native workspace and worker
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
  const continuationWedgeEnabled = process.env.CONTINUATION_WEDGE_ENABLED === 'true';
  app.use(createWorkshopRouter(db, { checkoutGuardEnabled: continuationWedgeEnabled }));
  // The Inbox: the rail, a thread, and what you do inside one. Project-scoped
  // work (ship, preview, go-live, attachments) stays on the workshop router.
  app.use(createThreadsRouter(db, {
    createRepo: (orgId, name, description) => createNewRepo(db, orgId, name, description),
    checkoutGuardEnabled: continuationWedgeEnabled,
  }));
  // Visible memory: one project's history, and search inside it.
  app.use(createTimelineRouter(db, { evidenceEnabled: continuationWedgeEnabled }));
  app.use(createSubjectsRouter(db));
  app.use(createDecisionsRouter(db));
  app.use('/api/import', uploadLimiter());
  app.use(createImportHistoryRouter(db));
  // Migration repositories use each customer's GitHub App installation and a
  // short-lived credential inside the route. Never inject the deployment PAT.
  app.use(createImportReplitRouter(db));
  app.use(createGithubArrivalRouter());
  // Minting a non-expiring bearer key is credential creation — bound the POST.
  app.use('/api/companion-keys', sensitiveLimiter());
  app.use(createCompanionKeysRouter(db));
  if (continuationWedgeEnabled) app.use(createContinuationsRouter(db, { ...(pushSender ? { pushSender } : {}) }));

  app.use(express.static(clientDir));

  // AN /api PATH NEVER FALLS THROUGH TO THE APP'S HTML.
  //
  // The catch-all below exists so a deep link into the single-page app serves
  // index.html rather than a 404. Before this line it caught unmatched /api
  // paths too, so a typo'd or retired endpoint answered a fetch with a page of
  // HTML — which the client then tried to parse as JSON and reported as a
  // syntax error about an unexpected "<". A wrong path is a wrong path; say so
  // in the shape every other refusal uses.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: "There's nothing at that address." });
  });

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
    // Written to be read by the person it happens to, not by the person who
    // wrote it. The reference stays, because it is the one technical detail
    // that earns its place: it turns a screenshot into a log line.
    res.status(500).json({
      error: `Something went wrong. Reference: ${ref}.`,
    });
  };
  app.use(onError);

  return app;
}
