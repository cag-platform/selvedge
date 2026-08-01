/**
 * Create a GitHub repo for a brand-new project — the "start from nothing"
 * path, ported from Toile's Ship flow. Uses the build engine's GITHUB_TOKEN
 * (sent as a header only — never logged, never echoed in errors). The repo
 * lands in GITHUB_ORG when that's set, otherwise under the token's own user.
 */

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

/**
 * Create a private repo, initialized with a README so it has a default branch
 * from the first second — the watcher has something to watch and the Workshop
 * has something to clone.
 */
export async function createNewRepo(name: string, description: string): Promise<CreatedRepo> {
  const org = (process.env.GITHUB_ORG ?? '').trim();
  const url = org ? `https://api.github.com/orgs/${org}/repos` : 'https://api.github.com/user/repos';
  const where = org || 'your GitHub account';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...API_HEADERS, Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
      body: JSON.stringify({ name, description, private: true, auto_init: true, has_wiki: false }),
    });
  } catch (err) {
    throw new GithubError(`could not reach GitHub (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as {
    full_name?: string;
    html_url?: string;
    message?: string;
    errors?: Array<{ message?: string }>;
  } | null;

  if (res.status === 201 && body?.full_name && body.html_url) {
    return { fullName: body.full_name, htmlUrl: body.html_url };
  }

  const detail = body?.errors?.[0]?.message ?? body?.message ?? '';
  if (res.status === 422 && /already exists/i.test(detail)) {
    throw new GithubError(`a repo named "${name}" already exists in ${where}`, true);
  }
  if (res.status === 401) {
    throw new GithubError('GitHub rejected the token (GITHUB_TOKEN is bad or expired)');
  }
  if (res.status === 403 || res.status === 404) {
    // 404 is GitHub's answer for "the token lacks access to the org" on org endpoints.
    throw new GithubError(`the token cannot create repos in ${where}${detail ? ` (${detail})` : ''}`);
  }
  throw new GithubError(`GitHub responded ${res.status}${detail ? `: ${detail}` : ''}`);
}
