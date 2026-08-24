/**
 * WHAT BRANCH DOES THIS REPO ACTUALLY BUILD FROM?
 *
 * The answer used to be assumed: every clone asked for `main`, and every repo
 * whose default branch is anything else died with "Remote branch main not
 * found" — after a sandbox had been started and a minute billed. That is most
 * repos that began life outside a template: GitHub's default branch is
 * whichever branch was pushed FIRST, so a repo whose first push came from a
 * Claude Code session on a working branch, or an older repo on `master`,
 * never had a `main` at all.
 *
 * So the branch is a fact to look up, not a convention to assume — asked with
 * the same installation token the clone itself will use, before any sandbox
 * exists, so an unreachable repo costs a sentence rather than a machine.
 *
 * The second question matters too: does the default branch EXIST yet? A repo
 * with no commits names a default branch it doesn't have, and cloning it
 * `--branch` fails no matter what the name is. That case is a flag, not a
 * failure — the sandbox clones the nothing and creates the branch, so a
 * brand-new repo is a place a builder can start.
 */

const GITHUB_API = 'https://api.github.com';

export type RepoInfo = { ok: true; defaultBranch: string; empty: boolean } | { ok: false; reason: string };

export type LookupRepoInfo = (token: string, repoFullName: string) => Promise<RepoInfo>;

export async function lookupRepoInfo(token: string, repoFullName: string): Promise<RepoInfo> {
  const get = (path: string) =>
    fetch(`${GITHUB_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });

  let repoRes: Response;
  try {
    repoRes = await get(`/repos/${repoFullName}`);
  } catch (err) {
    return { ok: false, reason: `I couldn't reach GitHub to look at ${repoFullName} (${err instanceof Error ? err.message : String(err)}).` };
  }
  if (!repoRes.ok) {
    return {
      ok: false,
      reason: `GitHub answered ${repoRes.status} for ${repoFullName} — the repo may have been renamed, deleted, or dropped from the installation.`,
    };
  }
  const repo = (await repoRes.json().catch(() => null)) as { default_branch?: unknown } | null;
  const defaultBranch = typeof repo?.default_branch === 'string' && repo.default_branch !== '' ? repo.default_branch : 'main';

  // The ref only exists once something has been committed. 404 here is the
  // empty-repo case, which is a real state to build in, not an error.
  let refRes: Response;
  try {
    refRes = await get(`/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  } catch (err) {
    return { ok: false, reason: `I couldn't reach GitHub to look at ${repoFullName} (${err instanceof Error ? err.message : String(err)}).` };
  }
  if (refRes.status === 404) return { ok: true, defaultBranch, empty: true };
  if (!refRes.ok) {
    return { ok: false, reason: `GitHub answered ${refRes.status} reading ${repoFullName}'s ${defaultBranch} branch.` };
  }
  return { ok: true, defaultBranch, empty: false };
}
