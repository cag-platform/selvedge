import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';
import type { Db } from '../db/client.js';
import { loadGithubAppConfig, type GithubAppConfig } from '../connectors/github/app.js';
import { listInstallations } from '../connectors/github/health.js';

/**
 * THE CREDENTIAL THE SANDBOX CLONES WITH.
 *
 * This exists because Selvedge used to read a repo with one identity and clone
 * it with another. Everything that WATCHES a project — the install backfill
 * that created the project in the first place, the webhooks, the health checks
 * — authenticates as the org's GitHub App installation. Everything that TOUCHED
 * the code authenticated as one deployment-wide personal access token in
 * GITHUB_TOKEN.
 *
 * Those two drift, and when they do the product lies: it lists a project,
 * describes it, offers to build in it, warms a sandbox, charges for the
 * minute — and then dies on `git clone` with "Invalid username or token",
 * because the App could see the repo and the PAT was never granted it. A
 * hand-managed token that has to be kept in step with every repo any customer
 * ever connects is not a mechanism, it's a promise to remember.
 *
 * So the clone now uses the same identity as the watching: a short-lived
 * installation access token, minted per build, carrying exactly the access the
 * owner granted when they installed the app and nothing else.
 *
 * TWO PROPERTIES WORTH KEEPING.
 *
 * Org-scoped. The installation that covers a repo is looked up from GitHub,
 * then checked against the installations THIS org registered. A pack that
 * names somebody else's repo therefore gets a refusal, not a token — the
 * multi-tenancy boundary holds at the credential, not just at the query.
 *
 * Honest when it can't. Every failure returns a sentence a person can act on,
 * and callers refuse the turn with it rather than starting a sandbox that is
 * going to die at the first git command. Spending someone's money to reach a
 * failure we could see coming is the thing this file is here to stop.
 */

export type RepoToken =
  | { ok: true; token: string; source: 'installation' | 'static' }
  | { ok: false; reason: string };

type Cached = { token: string; expiresAtMs: number };

/** Installation tokens live an hour; re-mint a little early rather than mid-clone. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** How long to trust "this repo belongs to that installation" before re-asking. */
const REPO_MAP_TTL_MS = 10 * 60_000;

const tokenCache = new Map<string, Cached>();
const repoInstallationCache = new Map<string, { installationId: string; atMs: number }>();

/** Tests reach for this; nothing in production should need it. */
export function clearRepoTokenCache(): void {
  tokenCache.clear();
  repoInstallationCache.clear();
}

function appConfig(): GithubAppConfig | null {
  try {
    return loadGithubAppConfig();
  } catch {
    return null;
  }
}

/** Which installation covers this repo, straight from GitHub, as the app itself. */
async function installationForRepo(config: GithubAppConfig, repoFullName: string): Promise<string | null> {
  const cached = repoInstallationCache.get(repoFullName);
  if (cached && Date.now() - cached.atMs < REPO_MAP_TTL_MS) return cached.installationId;

  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return null;
  const octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId: config.appId, privateKey: config.privateKey } });
  try {
    const res = await octokit.rest.apps.getRepoInstallation({ owner, repo });
    const installationId = String(res.data.id);
    repoInstallationCache.set(repoFullName, { installationId, atMs: Date.now() });
    return installationId;
  } catch {
    // 404 here means the app is not installed on that repo — which is a real
    // answer, not an error, and the caller turns it into a plain sentence.
    return null;
  }
}

async function mint(config: GithubAppConfig, installationId: string): Promise<string | null> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > Date.now()) return cached.token;
  try {
    const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
    const result = await auth({ type: 'installation', installationId });
    const expiresAtMs = result.expiresAt ? Date.parse(result.expiresAt) : Date.now() + 60 * 60_000;
    tokenCache.set(installationId, { token: result.token, expiresAtMs });
    return result.token;
  } catch {
    return null;
  }
}

export type RepoTokenDeps = {
  config?: () => GithubAppConfig | null;
  /** Which installation covers the repo, as GitHub sees it. */
  lookup?: (config: GithubAppConfig, repoFullName: string) => Promise<string | null>;
  mint?: (config: GithubAppConfig, installationId: string) => Promise<string | null>;
  staticToken?: () => string | undefined;
};

/**
 * A token that can clone `repoFullName` on behalf of `orgId`, or a plain
 * reason why not.
 *
 * The PAT fallback is for deployments with no GitHub App configured at all —
 * local development, and self-hosting where one owner's own token is the whole
 * story. Where the app IS configured it is the only path: falling back to a
 * PAT there would quietly restore the exact divergence this replaces.
 */
export async function resolveRepoToken(
  db: Db,
  orgId: string,
  repoFullName: string,
  deps: RepoTokenDeps = {},
): Promise<RepoToken> {
  const config = (deps.config ?? appConfig)();
  if (!config) {
    const fallback = (deps.staticToken ?? (() => process.env.GITHUB_TOKEN))()?.trim();
    if (fallback) return { ok: true, token: fallback, source: 'static' };
    return { ok: false, reason: "GitHub isn't connected here yet, so there's no way in to the code." };
  }

  const mine = await listInstallations(db, orgId);
  if (mine.length === 0) {
    return { ok: false, reason: "You haven't connected GitHub to Selvedge yet, so I can't reach the code." };
  }

  const covering = await (deps.lookup ?? installationForRepo)(config, repoFullName);
  if (!covering) {
    return {
      ok: false,
      reason: `Selvedge isn't installed on ${repoFullName}. Add it to the repositories the GitHub app can see, and I'll be able to work in it.`,
    };
  }
  // The boundary: a repo is only reachable through an installation THIS org
  // registered. Naming somebody else's repo in a pack gets you nothing.
  if (!mine.some((row) => row.sourceAccountId === covering)) {
    return { ok: false, reason: `${repoFullName} belongs to a GitHub account this workspace hasn't connected.` };
  }

  const token = await (deps.mint ?? mint)(config, covering);
  if (!token) {
    return { ok: false, reason: 'GitHub turned down the request for access to that repository just now.' };
  }
  return { ok: true, token, source: 'installation' };
}
