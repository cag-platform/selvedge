import { describe, it, expect } from 'vitest';
import { isSafeRepoFullName } from '../../../src/server/connectors/github/repoName.js';

describe('connectors/github/repoName', () => {
  it('accepts real owner/repo strings', () => {
    for (const ok of ['acme/widgets', 'a-b.c_d/e.f-g_h', 'Org123/Repo-99']) {
      expect(isSafeRepoFullName(ok)).toBe(true);
    }
  });

  it('rejects path-traversal that the old regex let through', () => {
    // Each of these matched /^[^/\s]+\/[^/\s]+$/ and would have reached
    // `/repos/${repoFullName}` on the GitHub API with the installation token.
    for (const bad of ['../..', 'a/..', '../x', '.', '..', 'a/../b', 'a/b/c', '/a/b', 'a b/c', 'a/']) {
      expect(isSafeRepoFullName(bad)).toBe(false);
    }
  });
});
