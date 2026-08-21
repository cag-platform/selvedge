import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The two things git can tell us about a session, and nothing else.
 *
 * No diffs, no file contents, no log messages — only which repository a
 * directory belongs to, and which commit (if any) landed while the session was
 * open. That restraint is the privacy promise in code: the companion reads a
 * repo to identify it and to line a session up with a commit, never to read the
 * work itself.
 *
 * Every call fails soft. A directory that isn't a repo, a git that isn't
 * installed, a repo with no remote — all of them are "I don't know", which the
 * summary then simply doesn't claim.
 */

const TIMEOUT_MS = 5000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    const trimmed = stdout.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/** owner/name for a directory's origin remote, in the shape a pack records it. */
export function normalizeRemote(url: string): string | null {
  const cleaned = url
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/[^/]*github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? cleaned : null;
}

export async function repoFor(cwd: string): Promise<string | null> {
  const url = await git(cwd, ['config', '--get', 'remote.origin.url']);
  return url ? normalizeRemote(url) : null;
}

/**
 * The last commit that landed in this repo while the session was open — the
 * "linked commit SHA" the brief asks for. It is a correlation, not a claim of
 * authorship: the session was open, and this commit appeared. Anything stronger
 * would need the commit to say so itself (which is exactly what Selvedge's own
 * ships do, with a Selvedge-Session trailer).
 */
export async function commitDuring(cwd: string, startedAt: Date, endedAt: Date): Promise<string | null> {
  const out = await git(cwd, [
    'log',
    '--since',
    startedAt.toISOString(),
    '--until',
    new Date(endedAt.getTime() + 60_000).toISOString(),
    '--format=%H',
    '-n',
    '5',
  ]);
  return out?.split('\n')[0]?.trim() ?? null;
}
