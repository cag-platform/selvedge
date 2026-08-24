import { describe, it, expect } from 'vitest';
import { cloneCommand, WORKDIR } from '../../src/server/build/sandbox.js';

/**
 * The clone string itself, because it is where "the branch is a looked-up
 * fact" actually lands. A repo with history is cloned at its own default by
 * name; a repo with no commits has no branch to ask for, so it is cloned bare
 * and the branch is created in the sandbox.
 */
describe('the sandbox clone', () => {
  const base = { githubToken: 'ghs_x', repoFullName: 'acme/yoke' };

  it('clones the repo at its own default branch, whatever it is called', () => {
    expect(cloneCommand({ ...base, branch: 'master' })).toBe(`git clone --branch 'master' https://github.com/acme/yoke.git ${WORKDIR}`);
    expect(cloneCommand({ ...base, branch: 'claude/first-build' })).toContain("--branch 'claude/first-build'");
  });

  it('clones an empty repo bare and creates its first branch', () => {
    const cmd = cloneCommand({ ...base, branch: 'main', emptyRepo: true });
    expect(cmd).not.toContain('--branch');
    expect(cmd).toContain(`git clone https://github.com/acme/yoke.git ${WORKDIR}`);
    expect(cmd).toContain("git checkout -b 'main'");
  });

  it('never lets a branch name escape its quoting', () => {
    const cmd = cloneCommand({ ...base, branch: "weird'; rm -rf /" });
    // The embedded quote is escaped ('\''), so the whole branch stays one
    // single-quoted shell WORD — data, not commands.
    expect(cmd).toContain(`--branch 'weird'\\''; rm -rf /'`);
  });
});
