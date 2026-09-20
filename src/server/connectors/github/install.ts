import { Router } from 'express';
import { tenantOf } from '../../web/middleware/tenant.js';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../../web/middleware/asyncHandler.js';
import { getInstallationOctokit, loadGithubAppConfig } from './app.js';
import { listInstallations, markInstalled, orgForInstallation } from './health.js';
import { backfillInstallation } from './backfill.js';
import { beginOAuthState, takeOAuthState } from '../oauthState.js';

/**
 * GitHub App install + setup-callback flow.
 *
 * WHY THE STATE IS SIGNED NOW. `state` used to be the org id in the clear, and
 * `/callback` trusted it. That let anyone bind a victim's installation to their
 * own org: `?installation_id=<victim>&state=org_attacker` on an endpoint that
 * sits in front of auth. The org row is keyed on (org, connector, account), so
 * the row was ADDED, not moved — the victim never saw it, and the attacker's
 * org could then list and mint tokens for the victim's private repos.
 *
 * The fix reuses the same single-use handshake the other OAuth flows use
 * (connectors/oauthState.ts): `/install` mints a random state bound to the
 * caller's org and consumes it on return. An attacker cannot forge a state for
 * a victim's org, so a NEW binding can only be created by the org that started
 * the flow. The state row is written and deleted per real connect — no polling,
 * no periodic cost.
 *
 * GitHub's own "Save"/re-configure redirect carries no state. That path may
 * only REFRESH a binding the signed-in caller's org already owns; it can never
 * create a new one. So a stateless callback for an installation the caller
 * doesn't already hold is refused rather than silently claimed.
 */
const GITHUB_INSTALL_PROVIDER = 'github_install';

export function createGithubInstallRouter(deps: { db: Db }) {
  const router = Router();

  router.get(
    '/api/connectors/github/install',
    asyncHandler(async (req, res) => {
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
      const state = await beginOAuthState(deps.db, orgId, GITHUB_INSTALL_PROVIDER);
      const url = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
      res.redirect(url);
    }),
  );

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

      // A signed state is the only way to create a NEW binding. It is random,
      // bound to the org that started the flow, and single-use, so it cannot be
      // forged for someone else's org.
      const rawState = req.query.state ? String(req.query.state) : '';
      const handshake = rawState ? await takeOAuthState(deps.db, rawState, GITHUB_INSTALL_PROVIDER) : null;

      let orgId = handshake?.orgId ?? null;

      if (!orgId) {
        // Stateless path — GitHub's re-configure "Save". Allowed only to
        // refresh a binding the signed-in caller's org ALREADY owns; it may
        // never claim an installation the caller doesn't hold.
        const sessionOrg = (() => {
          try {
            return tenantOf(req);
          } catch {
            return null;
          }
        })();
        const owner = await orgForInstallation(deps.db, installationId);
        if (sessionOrg && owner && sessionOrg === owner) {
          orgId = owner;
        }
      }

      if (!orgId) {
        res.status(400).json({
          error: 'could not verify this installation — start from Connect GitHub while signed in',
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
