import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { borrowCreateReturn, type GithubOAuthOps, type RepoSetupReceipt } from '../../connectors/github/repoSetup.js';
import { authorizeUrl, loadGithubOAuthConfig, realGithubOAuthOps } from '../../connectors/github/oauthOps.js';

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

type PendingSetup = { orgId: string; repoName: string };

/**
 * The borrow-and-return repo-setup flow (MIGRATION-CENTER §1), driven over
 * HTTP. `/start` sends the customer to GitHub for the one-time `repo` grant;
 * `/callback` runs the orchestration (create the one repo, hand the key back)
 * and returns a plain-language receipt.
 *
 * `ops` and `makeUrl` are injectable so the whole flow is testable without the
 * network; the mounted app uses the real GitHub adapter.
 *
 * Phase-1 simplification, shared with the existing install router and flagged
 * the same way: `state` carries the pending setup in-memory keyed by a random
 * id rather than a signed token. Sign it before this opens to other orgs.
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
  const pending = new Map<string, PendingSetup>();

  const makeState = (i: number) => `setup_${i}`; // deterministic; sign in production
  let counter = 0;

  router.post(
    '/api/connectors/github/setup/start',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const { appName } = req.body as { appName?: unknown };
      const repoName = repoNameFrom(typeof appName === 'string' ? appName : 'my-app');

      const state = makeState(counter++);
      pending.set(state, { orgId, repoName });

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
      const setup = pending.get(state);
      if (!code || !setup) {
        res.status(400).json({ error: "that link didn't carry what I needed — please start again" });
        return;
      }
      pending.delete(state); // one-time use

      const ops = opts.ops ?? realGithubOAuthOps(loadGithubOAuthConfig());
      const receipt: RepoSetupReceipt = await borrowCreateReturn(ops, code, setup.repoName);

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
