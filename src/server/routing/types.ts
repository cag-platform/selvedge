import type { StakesTier } from '../../shared/types/pack.js';

export type IntendedPath = 'SILENT' | 'TEMPLATE' | 'LIB' | 'LLM' | 'LLM+VERDICT';
/** Phase 1 never makes an LLM call: LIB/LLM/LLM+VERDICT all collapse to TEMPLATE. */
export type Path = 'SILENT' | 'TEMPLATE';
export type Delivery = 'NONE' | 'DIGEST' | 'PUSH';

export type TierDecision = {
  path: IntendedPath;
  delivery: Delivery;
  /** ⚡ in the doc — this decision may break quiet hours. */
  quiet_hours_override?: boolean;
};

export type RoutingRow = {
  id: string;
  group: string;
  event_type: string | null;
  label: string;
  notes?: string;
  v1_scope: boolean;
  standing?: boolean;
  reserved_reason?: string;
  tiers: Partial<Record<StakesTier, TierDecision | null>>;
};

export type RoutingTable = {
  tiers: StakesTier[];
  rows: RoutingRow[];
};

/**
 * Everything about the event that route() needs, expressed independently of
 * SiltaEvent so the pure routing module never has to import the full event
 * envelope (or touch `raw`). The resolution layer maps a SiltaEvent to this.
 */
export type RoutableEvent = {
  event_type: string;
};

/** Non-pack-derivable inputs the caller (resolution layer) must supply. */
export type RoutingContext = {
  /** Defaults to `new Date()`. Only used for the dormancy modifier's clock-free logic. */
  now?: Date;
  /** Project-local "HH:MM" (24h) at ingestion time. Omit to skip quiet-hours evaluation. */
  currentLocalTime?: string;
  /** Set true by the caller when this event's payload matched a pack.baselines.known_flaky pattern. */
  matchedKnownFlaky?: boolean;
  /** Push-worthy events already routed for this project in the trailing 15 minutes, NOT counting this one. */
  recentPushWorthyCount?: number;
  /** For C2 (runtime.recovered) only: did the outage this recovery answers actually push? */
  pairedOutagePushed?: boolean;
};

export type RoutingDecision = {
  row_id: string;
  event_type: string;
  path: Path;
  intended_path: IntendedPath;
  delivery: Delivery;
  /** Names of global modifiers that altered the table's base decision, in application order. */
  modifiers: string[];
};
