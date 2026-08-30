import { createAppAuth } from '@octokit/auth-app';
import type { Db } from '../../db/client.js';
import { loadGithubAppConfig } from './app.js';
import { listInstallations } from './health.js';

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

/** Thrown with a user-readable message (no token, no raw API dumps). */
export class GithubError extends Error {
  constructor(
    message: string,
    /** True when the failure is "a repo with that name already exists". */
    public alreadyExists = false,
  ) {
    super(message);
  }
}

export type CreatedRepo = { fullName: string; htmlUrl: string };

export async function createRepoWithInstallationToken(
  owner: string,
  token: string,
  name: string,
  description: string,
  request: typeof fetch = fetch,
): Promise<CreatedRepo> {
  const url = `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`;
  const where = owner;
  let res: Response;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, description, private: true, auto_init: true, has_wiki: false }),
    });
  } catch (err) {
    throw new GithubError(`could not reach GitHub (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as {
    full_name?: string; html_url?: string; message?: string; errors?: Array<{ message?: string }>;
  } | null;
  if (res.status === 201 && body?.full_name && body.html_url) return { fullName: body.full_name, htmlUrl: body.html_url };
  const detail = body?.errors?.[0]?.message ?? body?.message ?? '';
  if (res.status === 422 && /already exists/i.test(detail)) throw new GithubError(`a repo named "${name}" already exists in ${where}`, true);
  if (res.status === 401) throw new GithubError('GitHub rejected the short-lived installation credential; reconnect the Selvedge GitHub App');
  if (res.status === 403 || res.status === 404) throw new GithubError(`the Selvedge GitHub App cannot create repos in ${where}; grant Administration (write) permission${detail ? ` (${detail})` : ''}`);
  throw new GithubError(`GitHub responded ${res.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * Create a private repo, initialized with a README so it has a default branch
 * from the first second — the watcher has something to watch and the Workshop
 * has something to clone.
 */
export async function createNewRepo(db: Db, orgId: string, name: string, description: string): Promise<CreatedRepo> {
  const [installation] = await listInstallations(db, orgId);
  if (!installation) {
    throw new GithubError('connect the Selvedge GitHub App first');
  }
  const owner = installation.meta?.trim();
  if (!owner || owner === 'unknown') {
    throw new GithubError('the GitHub connection is missing its destination account; reconnect it and try again');
  }

  let token: string;
  try {
    const config = loadGithubAppConfig();
    const auth = createAppAuth({ appId: config.appId, privateKey: config.privateKey });
    token = (await auth({ type: 'installation', installationId: installation.sourceAccountId })).token;
  } catch {
    throw new GithubError('GitHub would not issue a short-lived installation credential; reconnect the Selvedge GitHub App');
  }

  return createRepoWithInstallationToken(owner, token, name, description);
}
