import type { Octokit } from 'octokit';
import type { Db } from '../../db/client.js';
import type { DeployCadence, InProgressItem } from '../../../shared/types/pack.js';
import { resolveProjectId } from '../../resolution/resolveProject.js';
import { archivedProjectIds, createPack, listPacks, updateMachineSections } from '../../packs/store.js';
import { canCreateProject } from '../../billing/entitlements.js';
import { scaffoldPackFromRepo } from '../../packs/scaffold.js';
import { getInstallationOctokit, loadGithubAppConfig } from './app.js';
import { listInstallations } from './health.js';

const BACKFILL_WINDOW_DAYS = 30;

/**
 * Rough deploy-cadence estimate from raw commit volume on the default
 * branch over the trailing 30 days. A real cadence measure would track
 * actual deploys (host connector territory, out of Phase 1 scope); this is
 * the best a GitHub-only backfill can infer, and it's only ever a seed —
 * live traffic (B2 events) refines it as the resolution layer processes
 * real deploys in Phase 2+.
 */
export function estimateDeployCadence(commitCountIn30d: number): DeployCadence {
  if (commitCountIn30d === 0) return 'dormant';
  if (commitCountIn30d >= 20) return 'multiple_daily';
  if (commitCountIn30d >= 8) return 'daily';
  return 'weekly';
}

/**
 * Seeds one repo's project pack from GitHub history: last 30 days of
 * default-branch commits (-> baselines.deploy_cadence) and open PRs (->
 * state.in_progress). No-op if no pack's topology.sources maps this repo
 * yet — live webhooks will land its events in the unsorted tray instead
 * until someone assigns it.
 */
export async function backfillRepo(db: Db, octokit: Octokit, orgId: string, repoFullName: string): Promise<void> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) return;

  const projectId = await resolveProjectId(db, orgId, 'github', repoFullName);
  if (!projectId) return;

  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const since = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    sha: repoInfo.default_branch,
    since,
    per_page: 100,
  });

  const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const inProgress: InProgressItem[] = openPrs.map((pr) => ({
    ref: pr.head.ref,
    summary: pr.title,
    opened_at: pr.created_at,
    last_activity_at: pr.updated_at,
  }));

  await updateMachineSections(db, orgId, projectId, {
    baselines: { deploy_cadence: estimateDeployCadence(commits.length) },
    state: {
      in_progress: inProgress,
      last_event_at_by_source: { github: new Date().toISOString() },
    },
  });
}

/**
 * Backfill one repo using whatever installation the org has — fired when a
 * pack is created after install (the install-time backfill skipped every
 * repo that had no pack yet). No-op without an installation or credentials.
 */
export async function backfillRepoForOrg(db: Db, orgId: string, repoFullName: string): Promise<void> {
  const [installation] = await listInstallations(db, orgId);
  if (!installation) return;
  const octokit = getInstallationOctokit(loadGithubAppConfig(), installation.sourceAccountId);
  await backfillRepo(db, octokit, orgId, repoFullName);
}

/**
 * Fired on install and on every installation re-configure. Every visible,
 * non-archived repo that no pack maps yet gets a draft pack auto-created
 * (personal tier, marked as a draft for the owner to refine) — connecting
 * an account should populate Projects on its own, not hand the owner a
 * data-entry job. Then each repo backfills 30 days of history.
 *
 * THE PROJECT LIMIT APPLIES HERE, and this is the only place in the product
 * where a plan limit bites something the owner didn't personally ask for.
 * That is deliberate, and the alternative was worse in both directions: skip
 * the check and connecting a GitHub account with twenty repos hands a free
 * account twenty projects, which makes the limit a suggestion; drop the
 * overflow repos and history silently goes missing.
 *
 * So the overflow lands in the unsorted tray instead, which is exactly what
 * the tray is for — one row per source, named as the repo it is, with "watch
 * it" waiting behind the same limit. Nothing is lost, nothing is hidden, and
 * upgrading turns each of them into a project with everything that has been
 * accumulating already attached. The history backfills either way: a repo
 * without a pack still stores its events, they just resolve to no project yet.
 */
export async function backfillInstallation(db: Db, octokit: Octokit, orgId: string): Promise<void> {
  const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
  const taken = new Set((await listPacks(db, orgId)).map((p) => p.identity.project_id));
  const archived = await archivedProjectIds(db, orgId);
  let leftInTray = 0;
  for (const repo of repos as Array<{ full_name: string; archived?: boolean }>) {
    if (repo.archived) continue;
    const projectId = await resolveProjectId(db, orgId, 'github', repo.full_name);
    // A repo whose project the owner permanently deleted stays dormant: don't
    // re-scaffold it and don't re-populate its (tombstoned) pack.
    if (projectId && archived.has(projectId)) continue;
    if (!projectId) {
      // Asked per repo rather than once up front: this loop creates projects as
      // it goes, so a count taken before it started would be stale by the
      // second one.
      if ((await canCreateProject(db, orgId)).allowed) {
        const draft = scaffoldPackFromRepo(repo.full_name, taken);
        await createPack(db, orgId, draft);
        taken.add(draft.identity.project_id);
      } else {
        leftInTray += 1;
      }
    }
    await backfillRepo(db, octokit, orgId, repo.full_name);
  }
  if (leftInTray > 0) {
    console.log(`${orgId}: ${leftInTray} repo(s) past the plan's project limit — history kept, waiting in the unsorted tray.`);
  }
}
