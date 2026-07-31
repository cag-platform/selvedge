/**
 * The event envelope — the most important contract in the codebase.
 * Every connector normalizes into this shape. Nothing downstream of the
 * connector layer ever reads `raw`.
 */

/** Mirrors context-pack.schema.json topology.sources[].connector enum. */
export type ConnectorKind =
  | 'github'
  | 'railway'
  | 'vercel'
  | 'neon'
  | 'supabase'
  | 'app_store_connect'
  | 'play_console'
  | 'replit'
  | 'custom';

export type SeverityHint = 'info' | 'warn' | 'error';

export type SelvedgeEvent = {
  id: string; // ulid
  org_id: string;
  source: ConnectorKind;
  source_account_id: string;
  project_id: string | null; // null until resolved
  event_type: string; // normalized, e.g. 'code.pr_merged', 'build.failed'
  occurred_at: string; // ISO
  received_at: string; // ISO
  severity_hint: SeverityHint;
  raw: unknown; // original payload, stored, never read downstream
  dedupe_key: string; // idempotency across webhook retries
};

/** Fields a connector normalizer produces; storage layer fills id/received_at/project_id. */
export type NewSelvedgeEvent = Omit<SelvedgeEvent, 'id' | 'received_at' | 'project_id'> & {
  project_id?: string | null;
};

/**
 * The normalized event_type vocabulary used by the routing table (Groups A/B/C/E).
 * Kept as a union (not an enum) so routing-table.json stays the single source of
 * truth for which rows exist; this type is the connector-facing contract.
 */
export type EventType =
  // Group A — code events
  | 'code.commit_pushed_non_default'
  | 'code.commits_landed_default'
  | 'code.pr_opened'
  | 'code.large_merge'
  | 'code.branch_stalled'
  | 'code.dormant_activity'
  // Group B — build & deploy events
  | 'build.started'
  | 'build.succeeded'
  | 'build.slow'
  | 'build.failed'
  | 'build.failed_known_flaky'
  | 'deploy.failed_previous_serving'
  | 'deploy.failed_nothing_serving'
  // Group C — runtime & data events
  | 'runtime.health_failing'
  | 'runtime.recovered'
  | 'runtime.recovered_hidden_dependency'
  | 'data.migration_failed'
  | 'data.resource_warning'
  | 'data.integrity_signal'
  | 'runtime.error_rate_spike'
  // Group E — trust & connector events (self-monitoring)
  | 'connector.auth_failed'
  | 'connector.stale_suspected'
  | 'connector.unsorted_accumulating';
