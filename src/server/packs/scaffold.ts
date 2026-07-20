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
