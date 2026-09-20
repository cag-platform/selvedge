/**
 * Is this a safe `owner/repo` string?
 *
 * The old check, `/^[^/\s]+\/[^/\s]+$/`, accepted `../..`, `a/..`, and `../x`:
 * a `..` segment contains no slash or whitespace, so it passed. That string is
 * later interpolated into a GitHub API path (`/repos/${repoFullName}`), where
 * `../../user/repos` normalizes to a different endpoint reached with the org's
 * installation token. GitHub owner and repo names are ASCII word/dot/dash, and
 * neither may be `.` or `..`, so require exactly that.
 */
export function isSafeRepoFullName(value: string): boolean {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}
