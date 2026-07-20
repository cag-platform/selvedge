import { Router, raw } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { connectorHealth } from '../../db/schema/index.js';
import type { NewSiltaEvent } from '../../../shared/types/event.js';
import { verifyGithubSignature } from './hmac.js';
import { normalizeCreateOrDelete, normalizePullRequest, normalizePush, normalizeWorkflowRun } from './normalizer.js';
import { getHealth, markAuthFailed, markFresh } from './health.js';
import { recordConnectorAuthFailed } from '../../resolution/connectorEvents.js';
import type { CreateOrDeletePayload, PullRequestPayload, PushPayload, WorkflowRunPayload } from './payloadTypes.js';

export type Ingest = (event: NewSiltaEvent) => Promise<void>;

/** Looks up which org installed this GitHub App installation. */
async function findOrgForInstallation(db: Db, installationId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: connectorHealth.orgId })
    .from(connectorHealth)
    .where(eq(connectorHealth.sourceAccountId, installationId))
    .limit(1);
  return row?.orgId ?? null;
}

/**
 * The GitHub webhook receiver. Mounted with express.raw() (not json())
 * because HMAC verification must run over the exact bytes GitHub sent.
 * `deps.ingest` is the resolution layer's entrypoint, injected rather than
 * imported directly so this connector stays testable without a DB and the
 * connectors→resolution dependency stays one-directional and explicit.
 */
export function createGithubWebhookRouter(deps: { db: Db; webhookSecret: string; ingest: Ingest }) {
  const router = Router();

  router.post('/webhooks/github', raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
    const rawBody = req.body as Buffer;
    const signature = req.header('x-hub-signature-256');
    const deliveryId = req.header('x-github-delivery') ?? 'unknown';
    const eventName = req.header('x-github-event');

    if (!verifyGithubSignature(rawBody, signature, deps.webhookSecret)) {
      // Best-effort: pull the installation id out of the (unverified) body
      // just to know whose connector_health to flag — never used to create
      // events. This is what makes acceptance gate 6 (kill the secret ->
      // health flips to auth_failed) observable.
      try {
        const unverified = JSON.parse(rawBody.toString('utf-8'));
        const installationId = unverified?.installation?.id ? String(unverified.installation.id) : null;
        if (installationId) {
          const orgId = await findOrgForInstallation(deps.db, installationId);
          if (orgId) {
            const priorHealth = await getHealth(deps.db, orgId, installationId);
            await markAuthFailed(deps.db, orgId, installationId);
            // Only narrate on the transition into auth_failed — otherwise a
            // secret that stays broken spams a new item on every retry.
            if (priorHealth?.status !== 'auth_failed') {
              await recordConnectorAuthFailed(deps.db, orgId, 'GitHub', 'github', installationId);
            }
          }
        }
      } catch {
        // Not parseable JSON either — nothing more we can do.
      }
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }

    const installationId = payload?.installation?.id ? String(payload.installation.id) : null;
    const orgId = installationId ? await findOrgForInstallation(deps.db, installationId) : null;

    if (!orgId) {
      // We verified the signature (it IS from GitHub) but don't know which
      // org this installation belongs to yet (e.g. a race with the install
      // callback). Ack so GitHub doesn't retry-storm us; nothing to ingest.
      res.status(202).json({ ok: true, note: 'unknown installation' });
      return;
    }

    let event: NewSiltaEvent | null = null;
    switch (eventName) {
      case 'push':
        event = normalizePush(orgId, payload as PushPayload);
        break;
      case 'pull_request':
        event = normalizePullRequest(orgId, payload as PullRequestPayload);
        break;
      case 'workflow_run':
        event = normalizeWorkflowRun(orgId, payload as WorkflowRunPayload);
        break;
      case 'create':
      case 'delete':
        event = normalizeCreateOrDelete(orgId, payload as CreateOrDeletePayload);
        break;
      default:
        event = null;
    }

    if (event) {
      await deps.ingest(event);
    }
    await markFresh(deps.db, orgId, installationId!);

    res.status(200).json({ ok: true, delivery: deliveryId, ingested: Boolean(event) });
  });

  return router;
}
