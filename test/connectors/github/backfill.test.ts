import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Octokit } from 'octokit';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { backfillInstallation } from '../../../src/server/connectors/github/backfill.js';
import { createPack, listPacks } from '../../../src/server/packs/store.js';
import { scaffoldPackFromRepo } from '../../../src/server/packs/scaffold.js';
import { makeTestPack } from '../../fixtures/testPack.js';

/**
 * Connecting a GitHub account must populate Projects on its own: every
 * visible repo without a pack gets a draft auto-created (personal tier —
 * the owner raises stakes, the product never guesses users onto a
 * project), archived repos are skipped, and already-mapped repos are
 * backfilled without duplication.
 */
describe('backfillInstallation auto-drafts projects', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  function fakeOctokit(repos: Array<{ full_name: string; archived?: boolean }>): Octokit {
    const octokit = {
      rest: {
        apps: { listReposAccessibleToInstallation: Symbol('listRepos') },
        repos: { get: async () => ({ data: { default_branch: 'main' } }), listCommits: Symbol('listCommits') },
        pulls: { list: Symbol('pulls') },
      },
      paginate: async (endpoint: unknown) =>
        endpoint === octokit.rest.apps.listReposAccessibleToInstallation ? repos : [],
    };
    return octokit as unknown as Octokit;
  }

  it('creates a draft pack for every unmapped, non-archived repo', async () => {
    await backfillInstallation(
      db,
      fakeOctokit([{ full_name: 'acme/loom' }, { full_name: 'acme/old-thing', archived: true }, { full_name: 'acme/mirror' }]),
      orgId,
    );

    const packs = await listPacks(db, orgId);
    expect(packs.map((p) => p.identity.project_id).sort()).toEqual(['loom', 'mirror']);
    const loom = packs.find((p) => p.identity.project_id === 'loom')!;
    expect(loom.stakes.tier).toBe('personal');
    expect(loom.identity.owner_description).toContain('Auto-created from acme/loom');
    expect(loom.topology.sources[0]).toEqual({ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' });
  });

  it('leaves repos that already map to a pack alone', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom (curated)', owner_description: 'x' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );

    await backfillInstallation(db, fakeOctokit([{ full_name: 'acme/loom' }]), orgId);

    const packs = await listPacks(db, orgId);
    expect(packs).toHaveLength(1);
    expect(packs[0]!.identity.name).toBe('Loom (curated)');
    expect(packs[0]!.stakes.tier).toBe('live_critical');
  });

  it('is idempotent across re-configure runs', async () => {
    const octokit = fakeOctokit([{ full_name: 'acme/loom' }]);
    await backfillInstallation(db, octokit, orgId);
    await backfillInstallation(db, octokit, orgId);
    expect(await listPacks(db, orgId)).toHaveLength(1);
  });

  it('scaffoldPackFromRepo dodges project-id collisions', () => {
    const taken = new Set(['loom', 'acme-loom']);
    const pack = scaffoldPackFromRepo('acme/loom', taken);
    expect(pack.identity.project_id).toBe('acme-loom-2');
  });
});
