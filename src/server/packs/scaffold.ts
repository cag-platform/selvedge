import type { ContextPack, StakesTier } from '../../shared/types/pack.js';

export type NewProjectInput = {
  name: string;
  repo: string; // GitHub full name, e.g. "acme/loom"
  tier: StakesTier;
  touches_money?: boolean;
  downtime_translation?: string;
};

export function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * A draft pack auto-created for a repo the installation can see but no
 * pack maps yet. Deliberately conservative: personal tier (calm by
 * default — the owner raises stakes in the editor, the product never
 * guesses users onto a project), and an owner_description that says
 * plainly it's a draft so the editor invites refinement.
 */
export function scaffoldPackFromRepo(repoFullName: string, takenProjectIds: ReadonlySet<string>): ContextPack {
  const repoName = repoFullName.split('/')[1] ?? repoFullName;
  let projectId = slugifyProjectId(repoName);
  if (!projectId || takenProjectIds.has(projectId)) {
    projectId = slugifyProjectId(repoFullName.replace('/', '-'));
  }
  let suffix = 2;
  const base = projectId;
  while (takenProjectIds.has(projectId)) projectId = `${base}-${suffix++}`;
  return {
    ...scaffoldPack({ name: repoName, repo: repoFullName, tier: 'personal' }),
    identity: {
      project_id: projectId,
      name: repoName,
      owner_description: `Auto-created from ${repoFullName} — edit this to teach Selvedge what it is and who uses it.`,
      links: { repo_url: `https://github.com/${repoFullName}` },
    },
  };
}

/**
 * A minimal valid pack from the New Project form. Everything here is a
 * starting point Greg refines in the pack editor; the backfill and live
 * events refine the machine-owned sections on their own.
 */
export function scaffoldPack(input: NewProjectInput): ContextPack {
  const projectId = slugifyProjectId(input.name);
  return {
    pack_version: '1.0',
    identity: {
      project_id: projectId,
      name: input.name,
      owner_description: `${input.name} is one of the owner's projects.`,
      links: { repo_url: `https://github.com/${input.repo}` },
    },
    stakes: {
      tier: input.tier,
      has_external_users: input.tier === 'live_small' || input.tier === 'live_critical',
      touches_money: input.touches_money ?? false,
      ...(input.downtime_translation ? { downtime_translation: input.downtime_translation } : {}),
    },
    topology: {
      sources: [{ connector: 'github', resource_id: input.repo, role: 'source_of_truth' }],
    },
    baselines: {
      // Seed guess; the install backfill and live deploys refine this.
      deploy_cadence: 'weekly',
    },
    state: {},
    trust: { overall_confidence: 'high' },
    voice: { detail_level: 'plain_expandable', notify: { push_threshold: 'failures' } },
  };
}
