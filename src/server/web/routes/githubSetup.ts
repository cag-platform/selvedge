import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { borrowCreateReturn, type GithubOAuthOps, type RepoSetupReceipt } from '../../connectors/github/repoSetup.js';
import { authorizeUrl, loadGithubOAuthConfig, realGithubOAuthOps } from '../../connectors/github/oauthOps.js';
import { beginOAuthState, takeOAuthState } from '../../connectors/oauthState.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Slugify an app name into a valid GitHub repo name; fall back to a safe default. */
export function repoNameFrom(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug.length >= 1 ? slug : 'my-app';
}

/**
 * The borrow-and-return repo-setup flow (MIGRATION-CENTER §1), driven over
 * HTTP. `/start` sends the customer to GitHub for the one-time `repo` grant;
 * `/callback` runs the orchestration (create the one repo, hand the key back)
 * and returns a plain-language receipt.
 *
 * `ops` and `makeUrl` are injectable so the whole flow is testable without the
 * network; the mounted app uses the real GitHub adapter.
 *
 * The handshake lives in the durable `oauth_states` store
 * (connectors/oauthState.ts) — the same one the Railway flow uses: random
 * 24-byte state, single-use delete-first consume, 15-minute TTL. It replaced
 * an in-process Map keyed `setup_${counter++}`, which was guessable and died
 * with the process — a consent screen open across a redeploy came back to a
 * server that had never heard of it. The handshake's `verifier` slot (free
 * text; Railway stores its PKCE verifier there) carries the repo name here.
 */
export function createGithubSetupRouter(
  db: Db,
  opts: {
    ops?: GithubOAuthOps;
    makeUrl?: (state: string) => string;
    redirectUri?: string;
  } = {},
) {
  const router = Router();

  router.post(
    '/api/connectors/github/setup/start',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const { appName } = req.body as { appName?: unknown };
      const repoName = repoNameFrom(typeof appName === 'string' ? appName : 'my-app');

      const state = await beginOAuthState(db, orgId, 'github_setup', repoName);

      const url = opts.makeUrl
        ? opts.makeUrl(state)
        : authorizeUrl(loadGithubOAuthConfig(), state, opts.redirectUri ?? '');
      // Return the URL rather than redirecting so the client opens it in the
      // popup that keeps the whole flow in-app.
      res.json({ authorize_url: url, state });
    }),
  );

  router.get(
    '/api/connectors/github/setup/callback',
    asyncHandler(async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      // Single-use by construction: the row is deleted as it's read, so a
      // replayed state — or one minted for a different provider — finds
      // nothing, and an authorization code is never exchangeable twice.
      const setup = code ? await takeOAuthState(db, state, 'github_setup') : null;
      if (!code || !setup) {
        res.status(400).json({ error: "that link didn't carry what I needed — please start again" });
        return;
      }
      const repoName = setup.verifier ?? 'my-app';

      const ops = opts.ops ?? realGithubOAuthOps(loadGithubOAuthConfig());
      const receipt: RepoSetupReceipt = await borrowCreateReturn(ops, code, repoName);

      // The plain-language line the customer sees. The technical register (the
      // acts, the repo full name) rides in the payload for the drill-down.
      const plain = receipt.ok
        ? `I set up your app's new home on GitHub — it's in your name, and I gave back the master key.`
        : (receipt.error ?? "Something went wrong setting up your app's home.");

      res.status(receipt.ok ? 200 : 502).json({ ok: receipt.ok, message: plain, receipt });
    }),
  );

  return router;
}
