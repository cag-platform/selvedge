import type { RepoInfo } from '../../src/server/build/repoInfo.js';

/**
 * The repo lookup, answered instantly. Same rationale as the static
 * GITHUB_TOKEN in test/setup.ts: every routed build test is about what happens
 * AFTER the repo resolves, and the real lookup is a network call to GitHub.
 * Tests about the lookup itself inject their own answers.
 */
export const stubRepoLookup = async (): Promise<RepoInfo> => ({ ok: true, defaultBranch: 'main', empty: false });
