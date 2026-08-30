import { GithubError } from './newRepo.js';

/**
 * PUT A TREE OF FILES INTO A REPO, AS ONE COMMIT.
 *
 * The git data API, driven directly: one blob per file, one tree on top of the
 * head commit's tree, one commit, one ref move. No clone, no sandbox, no
 * temporary directory holding somebody's app on our disk — the bytes go from
 * the upload buffer to GitHub and nowhere else.
 *
 * Uses the same GITHUB_TOKEN as repo creation, the same way: sent as a header
 * only, never logged, never echoed into an error. Every failure surfaces as a
 * GithubError with a person-readable sentence.
 *
 * ONE COMMIT ON PURPOSE. An import is one event in the repo's history —
 * "Imported from Replit" — not four hundred. It lands ON TOP of the head
 * (auto-init's README included) rather than rewriting anything, so pushing
 * into a repo that already has work never destroys it; at worst it layers, and
 * git can always show what came from where.
 */

const API = 'https://api.github.com';
const HEADERS = (token: string) => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

/** Blob creation runs a few at a time — hundreds in series is minutes, hundreds at once is a secondary rate limit. */
const BLOB_CONCURRENCY = 8;

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers: HEADERS(token) });
  } catch (err) {
    throw new GithubError(`could not reach GitHub (${err instanceof Error ? err.message : String(err)})`);
  }
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || (body === null && res.status !== 204)) {
    throw new GithubError(`GitHub responded ${res.status}${body?.message ? `: ${body.message}` : ''}`);
  }
  return body as T;
}

export type PushResult = { commitSha: string; branch: string; files: number };

export async function createPreviewRefWithToken(
  token: string,
  fullName: string,
  files: Array<{ path: string; bytes: Uint8Array }>,
  ref: string,
): Promise<PushResult> {
  if (!/^selvedge-preview\/[A-Za-z0-9._-]+$/.test(ref)) throw new GithubError('invalid disposable preview ref');
  if (!token.trim() || files.length === 0) throw new GithubError('GitHub preview source is unavailable');
  const repo = await gh<{ default_branch: string }>(token, `/repos/${fullName}`);
  const head = await gh<{ object: { sha: string } }>(token, `/repos/${fullName}/git/ref/${encodeURIComponent(`heads/${repo.default_branch}`)}`);
  const shas = new Array<string>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const blob = await gh<{ sha: string }>(token, `/repos/${fullName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: Buffer.from(files[i]!.bytes).toString('base64'), encoding: 'base64' }),
      });
      shas[i] = blob.sha;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, files.length) }, worker));
  const tree = await gh<{ sha: string }>(token, `/repos/${fullName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: files.map((file, i) => ({ path: file.path, mode: '100644', type: 'blob', sha: shas[i] })) }),
  });
  const commit = await gh<{ sha: string }>(token, `/repos/${fullName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Selvedge disposable preview', tree: tree.sha, parents: [head.object.sha] }),
  });
  await gh(token, `/repos/${fullName}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: commit.sha }),
  });
  return { commitSha: commit.sha, branch: ref, files: files.length };
}

export async function deletePreviewRefWithToken(token: string, fullName: string, ref: string): Promise<void> {
  if (!/^selvedge-preview\/[A-Za-z0-9._-]+$/.test(ref)) throw new GithubError('invalid disposable preview ref');
  await gh(token, `/repos/${fullName}/git/refs/${encodeURIComponent(`heads/${ref}`)}`, { method: 'DELETE' });
}

/** Push using a credential supplied by the caller. Installation credentials are
 * short-lived and tenant-scoped; keeping the token out of module state prevents
 * one deployment identity from quietly becoming every customer's GitHub key. */
export async function pushFilesToRepoWithToken(token: string, fullName: string, files: Array<{ path: string; bytes: Uint8Array }>, message: string): Promise<PushResult> {
  if (!token.trim()) throw new GithubError('GitHub did not provide a repository credential');
  if (files.length === 0) throw new GithubError('nothing to push');

  const repo = await gh<{ default_branch: string }>(token, `/repos/${fullName}`);
  const branch = repo.default_branch;
  const head = await gh<{ object: { sha: string } }>(token, `/repos/${fullName}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
  const headCommit = await gh<{ tree: { sha: string } }>(token, `/repos/${fullName}/git/commits/${head.object.sha}`);

  // Blobs, a few at a time. Base64 for every file: it is byte-exact for
  // binaries and merely wasteful for text, and an importer that guesses wrong
  // about which is which corrupts somebody's app.
  const shas = new Array<string>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const f = files[i]!;
      const blob = await gh<{ sha: string }>(token, `/repos/${fullName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: Buffer.from(f.bytes).toString('base64'), encoding: 'base64' }),
      });
      shas[i] = blob.sha;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, files.length) }, worker));

  const tree = await gh<{ sha: string }>(token, `/repos/${fullName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas[i] })),
    }),
  });

  const commit = await gh<{ sha: string }>(token, `/repos/${fullName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [head.object.sha] }),
  });

  await gh(token, `/repos/${fullName}/git/refs/${encodeURIComponent(`heads/${branch}`)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commitSha: commit.sha, branch, files: files.length };
}

/** Legacy/self-hosted adapter. Product migration code must use the explicit,
 * customer-scoped credential entry point above. */
export async function pushFilesToRepo(fullName: string, files: Array<{ path: string; bytes: Uint8Array }>, message: string): Promise<PushResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new GithubError('pushing files needs the build engine’s GITHUB_TOKEN');
  return pushFilesToRepoWithToken(token, fullName, files, message);
}
