import { Router } from 'express';
import { getAuth } from '@clerk/express';
import type { Db } from '../../db/client.js';
import { getInstallationOctokit, loadGithubAppConfig } from './app.js';
import { markInstalled } from './health.js';
import { backfillInstallation } from './backfill.js';

/**
 * GitHub App install + setup-callback flow. `/install` requires an
 * authenticated org (mounted behind Clerk middleware in web/); `/callback`
 * is GitHub's redirect target and carries the org back via `state`.
 *
 * Phase 1 simplification: `state` is passed as a plain org id, not a
 * signed token verified against the session that started the flow. Fine
 * for solo dogfooding; flagged in the PR description as a hardening item
 * before this is opened to other orgs.
 */
export function createGithubInstallRouter(deps: { db: Db }) {
  const router = Router();

  router.get('/api/connectors/github/install', (req, res) => {
    const orgId = getAuth(req).orgId;
    if (!orgId) {
      res.status(401).json({ error: 'no active organization' });
      return;
    }
    const appSlug = process.env.GITHUB_APP_SLUG;
    if (!appSlug) {
      res.status(500).json({ error: 'GITHUB_APP_SLUG is not set' });
      return;
    }
    const url = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(orgId)}`;
    res.redirect(url);
  });

  router.get('/api/connectors/github/callback', async (req, res) => {
    const installationId = req.query.installation_id ? String(req.query.installation_id) : null;
    const orgId = req.query.state ? String(req.query.state) : null;

    if (!installationId || !orgId) {
      res.status(400).json({ error: 'missing installation_id or state' });
      return;
    }

    const config = loadGithubAppConfig();
    const octokit = getInstallationOctokit(config, installationId);
    const { data: installation } = await octokit.rest.apps.getInstallation({ installation_id: Number(installationId) });
    const accountLogin = (installation.account as { login?: string } | null)?.login ?? 'unknown';

    await markInstalled(deps.db, orgId, installationId, accountLogin);

    // Fire-and-forget: don't make the user wait on the redirect for 30 days
    // of history across every repo in the installation.
    void backfillInstallation(deps.db, octokit, orgId).catch((err) => {
      console.error(`backfill failed for org ${orgId} installation ${installationId}:`, err);
    });

    res.redirect('/?github_connected=1');
  });

  return router;
}
