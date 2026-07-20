/**
 * TypeScript mirror of docs/context-pack.schema.json (pack_version 1.0).
 * The JSON Schema (validated via ajv at write time) remains the source of
 * truth; this type is for compile-time ergonomics in the app code.
 *
 * Section ownership (enforced in the API layer, src/server/packs):
 *   HUMAN-OWNED    identity, stakes, voice
 *   MACHINE-OWNED  topology.sources (additive only), baselines, state, trust
 */

import type { ConnectorKind } from './event.js';

export type StakesTier = 'sandbox' | 'personal' | 'live_small' | 'live_critical';
export type UserScale = 'none' | 'handful' | 'dozens' | 'hundreds' | 'thousands_plus';
export type BusinessRole =
  | 'revenue_product'
  | 'internal_operations'
  | 'internal_tooling'
  | 'marketing_surface'
  | 'experiment';

export type SourceRole =
  | 'source_of_truth'
  | 'code_mirror'
  | 'production_host'
  | 'preview_host'
  | 'database'
  | 'storage'
  | 'store_listing'
  | 'auxiliary';

export type Environment = 'production' | 'staging' | 'preview' | 'development';

export type TopologySource = {
  connector: ConnectorKind;
  resource_id: string;
  role: SourceRole;
  environment?: Environment;
  notes?: string;
};

export type CapabilityGap = {
  gap: string;
  summary: string;
  blocking?: string;
};

export type DeployCadence = 'multiple_daily' | 'daily' | 'weekly' | 'monthly' | 'dormant';

export type KnownFlaky = {
  pattern: string;
  note?: string;
  graduated?: boolean;
};

export type InProgressItem = {
  ref: string;
  summary?: string;
  opened_at?: string;
  last_activity_at?: string;
};

export type SourceTrustStatus = 'fresh' | 'quiet' | 'stale_suspected' | 'disconnected' | 'auth_failed';

export type TrustSourceEntry = {
  status: SourceTrustStatus;
  last_verified_at?: string;
  note?: string;
};

export type DetailLevel = 'plain_only' | 'plain_expandable' | 'technical_forward';
export type PushThreshold = 'never' | 'critical_only' | 'failures' | 'everything';

export type GlossaryOverride = {
  term: string;
  preferred_phrasing: string;
  graduated_at?: string;
};

export type ContextPack = {
  pack_version: '1.0';
  identity: {
    project_id: string;
    name: string;
    owner_description: string;
    audience?: string;
    links?: {
      live_url?: string;
      repo_url?: string;
      host_dashboard_url?: string;
      store_listing_url?: string;
    };
  };
  stakes: {
    tier: StakesTier;
    has_external_users: boolean;
    user_scale?: UserScale;
    touches_money: boolean;
    business_role?: BusinessRole;
    downtime_translation?: string;
  };
  topology: {
    sources: TopologySource[];
    serves?: string[];
    consumes?: string[];
    stack_summary?: string;
    capability_gaps?: CapabilityGap[];
  };
  baselines?: {
    deploy_cadence?: DeployCadence;
    typical_build_seconds?: number;
    build_failure_rate_30d?: number;
    known_flaky?: KnownFlaky[];
    active_hours_utc?: { start?: number; end?: number };
  };
  state?: {
    serving_now?: { version_ref?: string | null; deployed_at?: string | null; healthy?: boolean | null };
    last_successful_deploy?: string;
    in_progress?: InProgressItem[];
    stalled?: InProgressItem[];
    last_event_at_by_source?: Record<string, string>;
  };
  trust?: {
    sources?: Record<string, TrustSourceEntry>;
    overall_confidence?: 'high' | 'partial' | 'low';
  };
  voice: {
    detail_level: DetailLevel;
    language?: string;
    notify?: {
      push_threshold?: PushThreshold;
      quiet_hours_local?: { start?: string; end?: string };
    };
    glossary_overrides?: GlossaryOverride[];
  };
};
