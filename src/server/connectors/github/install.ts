import { Router } from 'express';
import { tenantOf } from '../../web/middleware/tenant.js';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../../web/middleware/asyncHandler.js';
import { getInstallationOctokit, loadGithubAppConfig } from './app.js';
import { listInstallations, markInstalled, orgForInstallation } from './health.js';
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
    const orgId = tenantOf(req);
    if (!orgId) {
      res.status(401).json({ error: 'not signed in' });
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

  // Repos the org's installation can see — feeds the New Project repo picker.
  router.get(
    '/api/connectors/github/repos',
    asyncHandler(async (req, res) => {
      const orgId = tenantOf(req);
      if (!orgId) {
        res.status(401).json({ error: 'not signed in' });
        return;
      }
      const [installation] = await listInstallations(deps.db, orgId);
      if (!installation) {
        res.json([]);
        return;
      }
      const octokit = getInstallationOctokit(loadGithubAppConfig(), installation.sourceAccountId);
      const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      res.json((repos as Array<{ full_name: string }>).map((r) => ({ full_name: r.full_name })));
    }),
  );

  router.get(
    '/api/connectors/github/callback',
    asyncHandler(async (req, res) => {
      const installationId = req.query.installation_id ? String(req.query.installation_id) : null;
      if (!installationId) {
        res.status(400).json({ error: 'missing installation_id' });
        return;
      }

      // `state` only exists when the flow started from our install link.
      // GitHub's own "Save"/re-configure redirect carries none, so fall
      // back to the signed-in session, then to whichever org registered
      // this installation the first time around.
      let orgId = req.query.state ? String(req.query.state) : null;
      if (!orgId) {
        try {
          orgId = tenantOf(req);
        } catch {
          orgId = null;
        }
      }
      if (!orgId) orgId = await orgForInstallation(deps.db, installationId);
      if (!orgId) {
        res.status(400).json({
          error: 'could not determine which organization this installation belongs to — start from /api/connectors/github/install while signed in',
        });
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
    }),
  );

  return router;
}
