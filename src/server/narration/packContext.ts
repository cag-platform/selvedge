import type { ContextPack } from '../../shared/types/pack.js';

/**
 * The narrator-relevant slice of a pack (brief, deliverable 3) — a
 * selector, not the raw pack. Keeps prompts small, keeps machine-internal
 * fields (glossary graduation timestamps, link URLs, full state history)
 * out of the model's context, and gives the eval harness a stable surface
 * to entity-diff against.
 */
export type NarratorContext = {
  name: string;
  owner_description: string;
  audience?: string;
  stakes: {
    tier: string;
    has_external_users: boolean;
    touches_money: boolean;
    business_role?: string;
    downtime_translation?: string;
  };
  topology_notes: string[];
  stack_summary?: string;
  baselines?: {
    deploy_cadence?: string;
    typical_build_seconds?: number;
    build_failure_rate_30d?: number;
  };
  trust: {
    overall_confidence?: string;
    degraded_sources: Array<{ source: string; status: string; note?: string }>;
  };
  detail_level: string;
  language: string;
};

export function packToNarratorContext(pack: ContextPack): NarratorContext {
  const degradedSources = Object.entries(pack.trust?.sources ?? {})
    .filter(([, entry]) => entry.status !== 'fresh')
    .map(([source, entry]) => ({ source, status: entry.status, ...(entry.note ? { note: entry.note } : {}) }));

  return {
    name: pack.identity.name,
    owner_description: pack.identity.owner_description,
    ...(pack.identity.audience ? { audience: pack.identity.audience } : {}),
    stakes: {
      tier: pack.stakes.tier,
      has_external_users: pack.stakes.has_external_users,
      touches_money: pack.stakes.touches_money,
      ...(pack.stakes.business_role ? { business_role: pack.stakes.business_role } : {}),
      ...(pack.stakes.downtime_translation ? { downtime_translation: pack.stakes.downtime_translation } : {}),
    },
    topology_notes: pack.topology.sources.filter((s) => s.notes).map((s) => `${s.connector}/${s.role}: ${s.notes}`),
    ...(pack.topology.stack_summary ? { stack_summary: pack.topology.stack_summary } : {}),
    ...(pack.baselines
      ? {
          baselines: {
            ...(pack.baselines.deploy_cadence ? { deploy_cadence: pack.baselines.deploy_cadence } : {}),
            ...(pack.baselines.typical_build_seconds !== undefined
              ? { typical_build_seconds: pack.baselines.typical_build_seconds }
              : {}),
            ...(pack.baselines.build_failure_rate_30d !== undefined
              ? { build_failure_rate_30d: pack.baselines.build_failure_rate_30d }
              : {}),
          },
        }
      : {}),
    trust: {
      ...(pack.trust?.overall_confidence ? { overall_confidence: pack.trust.overall_confidence } : {}),
      degraded_sources: degradedSources,
    },
    detail_level: pack.voice.detail_level,
    language: pack.voice.language ?? 'en',
  };
}
