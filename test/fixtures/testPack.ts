import type { ContextPack, StakesTier } from '../../src/shared/types/pack.js';

/** Minimal valid pack builder for routing/resolution/narration tests. */
export function makeTestPack(overrides: Partial<ContextPack> = {}): ContextPack {
  const tier: StakesTier = overrides.stakes?.tier ?? 'live_small';
  return {
    pack_version: '1.0',
    identity: {
      project_id: 'test-project',
      name: 'Test Project',
      owner_description: 'A project used in tests.',
      ...overrides.identity,
    },
    stakes: {
      tier,
      has_external_users: true,
      touches_money: false,
      ...overrides.stakes,
    },
    topology: {
      sources: [{ connector: 'github', resource_id: 'acme/test-project', role: 'source_of_truth' }],
      ...overrides.topology,
    },
    baselines: {
      deploy_cadence: 'weekly',
      ...overrides.baselines,
    },
    state: {
      ...overrides.state,
    },
    trust: {
      overall_confidence: 'high',
      ...overrides.trust,
    },
    voice: {
      detail_level: 'plain_expandable',
      ...overrides.voice,
    },
  };
}
