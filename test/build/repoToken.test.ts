import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { markInstalled } from '../../src/server/connectors/github/health.js';
import { resolveRepoToken, clearRepoTokenCache } from '../../src/server/build/repoToken.js';
import { configFor } from '../../src/server/build/engineConfig.js';
import { createPack } from '../../src/server/packs/store.js';
import { scaffoldPack } from '../../src/server/packs/scaffold.js';

/**
 * The bug this file exists to keep dead: Selvedge could SEE a repo it could not
 * CLONE. Watching authenticated as the org's GitHub App installation; cloning
 * authenticated as one deployment-wide personal access token. A project created
 * by the backfill (because the installation could see it) would list, describe,
 * warm a sandbox, bill for the minute — and then die on `git clone` with
 * "Invalid username or token", because that PAT had never been granted it.
 *
 * So the rule under test is: the credential that clones is the credential that
 * watches, and when it cannot be had, the answer is a sentence rather than a
 * started machine.
 */
describe('the credential that clones is the one that watches', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  const app = { appId: '1', privateKey: 'pem' };
  const config = () => app;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    clearRepoTokenCache();
    delete process.env.GITHUB_TOKEN;
    await db.insert(orgs).values([{ orgId: 'mine' }, { orgId: 'theirs' }]);
  });
  afterEach(async () => {
    clearRepoTokenCache();
    delete process.env.GITHUB_TOKEN;
    await close();
  });

  it('mints a token from the installation that covers the repo', async () => {
    await markInstalled(db, 'mine', '42', 'cag-platform');
    const result = await resolveRepoToken(db, 'mine', 'cag-platform/balance', {
      config,
      lookup: async () => '42',
      mint: async (_c, id) => `ghs_for_${id}`,
    });
    expect(result).toEqual({ ok: true, token: 'ghs_for_42', source: 'installation' });
  });

  it("refuses a repo covered by an installation this org never registered", async () => {
    // The multi-tenancy boundary at the credential, not just at the query: org
    // "mine" naming someone else's repo must not receive a working token for it.
    await markInstalled(db, 'mine', '42', 'cag-platform');
    await markInstalled(db, 'theirs', '99', 'someone-else');
    const result = await resolveRepoToken(db, 'mine', 'someone-else/ledger', {
      config,
      lookup: async () => '99',
      mint: async () => 'ghs_should_never_be_minted',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("hasn't connected");
  });

  it('says plainly when the app simply is not on that repo', async () => {
    await markInstalled(db, 'mine', '42', 'cag-platform');
    const result = await resolveRepoToken(db, 'mine', 'cag-platform/balance', {
      config,
      lookup: async () => null,
      mint: async () => 'unreachable',
    });
    expect(result.ok).toBe(false);
    // The sentence has to name the repo and the remedy, because "auth failed"
    // sends people to rotate a token that was never the problem.
    if (!result.ok) {
      expect(result.reason).toContain('cag-platform/balance');
      expect(result.reason).toMatch(/install/i);
    }
  });

  it('says plainly when GitHub has never been connected at all', async () => {
    const result = await resolveRepoToken(db, 'mine', 'cag-platform/balance', { config, lookup: async () => '42' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/connected GitHub/i);
  });

  it('falls back to a configured token only where no app exists', async () => {
    // Local development and single-owner self-hosting: no app, one token, and
    // everything still works. Where an app IS configured this path is closed —
    // falling back there would restore the very divergence being removed.
    const result = await resolveRepoToken(db, 'mine', 'cag-platform/balance', {
      config: () => null,
      staticToken: () => 'ghp_local',
    });
    expect(result).toEqual({ ok: true, token: 'ghp_local', source: 'static' });

    const withApp = await resolveRepoToken(db, 'mine', 'cag-platform/balance', {
      config,
      staticToken: () => 'ghp_local',
      lookup: async () => '42',
    });
    expect(withApp.ok).toBe(false);
  });

  it('refuses the turn before a sandbox exists, with the reason', async () => {
    // The point of resolving early: an unreachable repo costs a sentence, not a
    // machine, a minute of compute, and a puzzling failure at the first git
    // command.
    await createPack(db, 'mine', scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
    const refusal = await configFor(
      db,
      'mine',
      'balance',
      () => ({ claudeCodeOauthToken: 'cc' }),
      async () => ({ ok: false, reason: "Selvedge isn't installed on cag-platform/balance." }),
    );
    expect(refusal).toEqual({ status: 409, error: "Selvedge isn't installed on cag-platform/balance." });
  });

  it('hands the resolved token to the sandbox config when it can be had', async () => {
    await createPack(db, 'mine', scaffoldPack({ name: 'balance', repo: 'cag-platform/balance', tier: 'personal' }));
    const resolved = await configFor(
      db,
      'mine',
      'balance',
      () => ({ claudeCodeOauthToken: 'cc' }),
      async () => ({ ok: true, token: 'ghs_live', source: 'installation' }),
      async () => ({ ok: true, defaultBranch: 'main', empty: false }),
    );
    expect(resolved).toMatchObject({ cfg: { githubToken: 'ghs_live', repoFullName: 'cag-platform/balance' } });
  });

  /**
   * THE BUG THIS BLOCK KEEPS DEAD: every clone used to ask for `main`, so any
   * repo whose default branch is anything else — most repos whose first push
   * came from a Claude Code working branch, and everything older on `master` —
   * died in the sandbox with "Remote branch main not found", after the machine
   * had been started and the minute billed. The branch is a looked-up fact now.
   */
  describe('the branch is the repo\'s own, never an assumption', () => {
    const okToken = async () => ({ ok: true, token: 'ghs_live', source: 'installation' }) as const;

    it('builds on whatever GitHub says the default branch is', async () => {
      await createPack(db, 'mine', scaffoldPack({ name: 'yoke', repo: 'cag-platform/yoke', tier: 'personal' }));
      const asked: string[] = [];
      const resolved = await configFor(db, 'mine', 'yoke', () => ({ claudeCodeOauthToken: 'cc' }), okToken, async (token, full) => {
        asked.push(`${token} ${full}`);
        return { ok: true, defaultBranch: 'claude/first-build', empty: false };
      });
      expect(resolved).toMatchObject({ cfg: { branch: 'claude/first-build', emptyRepo: false } });
      // Looked up with the same credential the clone will use.
      expect(asked).toEqual(['ghs_live cag-platform/yoke']);
    });

    it('flags a repo with no commits instead of asking to clone a branch that is not there', async () => {
      await createPack(db, 'mine', scaffoldPack({ name: 'bare', repo: 'cag-platform/bare', tier: 'personal' }));
      const resolved = await configFor(db, 'mine', 'bare', () => ({ claudeCodeOauthToken: 'cc' }), okToken, async () => ({
        ok: true,
        defaultBranch: 'main',
        empty: true,
      }));
      expect(resolved).toMatchObject({ cfg: { branch: 'main', emptyRepo: true } });
    });

    it('refuses with the lookup\'s own sentence when the repo cannot be read', async () => {
      await createPack(db, 'mine', scaffoldPack({ name: 'gone', repo: 'cag-platform/gone', tier: 'personal' }));
      const refusal = await configFor(db, 'mine', 'gone', () => ({ claudeCodeOauthToken: 'cc' }), okToken, async () => ({
        ok: false,
        reason: 'GitHub answered 404 for cag-platform/gone — the repo may have been renamed, deleted, or dropped from the installation.',
      }));
      expect(refusal).toMatchObject({ status: 409 });
      expect((refusal as { error: string }).error).toContain('cag-platform/gone');
    });
  });
});
