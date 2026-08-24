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
const HEADERS = () => ({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
});

/** Blob creation runs a few at a time — hundreds in series is minutes, hundreds at once is a secondary rate limit. */
const BLOB_CONCURRENCY = 8;

async function gh<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers: HEADERS() });
  } catch (err) {
    throw new GithubError(`could not reach GitHub (${err instanceof Error ? err.message : String(err)})`);
  }
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || body === null) {
    throw new GithubError(`GitHub responded ${res.status}${body?.message ? `: ${body.message}` : ''}`);
  }
  return body;
}

export type PushResult = { commitSha: string; branch: string; files: number };

export async function pushFilesToRepo(fullName: string, files: Array<{ path: string; bytes: Uint8Array }>, message: string): Promise<PushResult> {
  if (!process.env.GITHUB_TOKEN) throw new GithubError('pushing files needs the build engine’s GITHUB_TOKEN');
  if (files.length === 0) throw new GithubError('nothing to push');

  const repo = await gh<{ default_branch: string }>(`/repos/${fullName}`);
  const branch = repo.default_branch;
  const head = await gh<{ object: { sha: string } }>(`/repos/${fullName}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
  const headCommit = await gh<{ tree: { sha: string } }>(`/repos/${fullName}/git/commits/${head.object.sha}`);

  // Blobs, a few at a time. Base64 for every file: it is byte-exact for
  // binaries and merely wasteful for text, and an importer that guesses wrong
  // about which is which corrupts somebody's app.
  const shas = new Array<string>(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const f = files[i]!;
      const blob = await gh<{ sha: string }>(`/repos/${fullName}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: Buffer.from(f.bytes).toString('base64'), encoding: 'base64' }),
      });
      shas[i] = blob.sha;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, files.length) }, worker));

  const tree = await gh<{ sha: string }>(`/repos/${fullName}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas[i] })),
    }),
  });

  const commit = await gh<{ sha: string }>(`/repos/${fullName}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [head.object.sha] }),
  });

  await gh(`/repos/${fullName}/git/refs/${encodeURIComponent(`heads/${branch}`)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commitSha: commit.sha, branch, files: files.length };
}
