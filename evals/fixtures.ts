import type { ContextPack, StakesTier, DetailLevel } from '../src/shared/types/pack.js';

/**
 * ~15 synthetic day fixtures (Phase 2 deliverable 7). Each describes one
 * org-day: the packs, yesterday's events, and what the composed brief is
 * gated on. The five golden briefs (Greg's hand-written references) live in
 * docs/golden-set/; style similarity against them is reported, not gated.
 */

export type FixtureEvent = {
  event_type: string;
  resource_id: string; // matches a pack topology source
  hour?: number; // hour-of-day yesterday UTC (default 10)
  raw?: unknown;
};

export type EvalFixture = {
  name: string;
  description: string;
  packs: Array<{
    project_id: string;
    name: string;
    tier: StakesTier;
    touches_money?: boolean;
    detail_level?: DetailLevel;
    resource_id: string;
    downtime_translation?: string;
    capability_gap?: string;
    degraded_trust?: boolean;
    has_deployed_before?: boolean;
    known_flaky?: string;
  }>;
  events: FixtureEvent[];
  /** Open threads carried in from "yesterday's digest". */
  previousOpenThreads?: Array<{ project_id: string; summary: string }>;
  expect: {
    /** Projects whose carried-in thread must be closed (no attention item today). */
    closedThreadProjects?: string[];
    stormMode?: boolean;
    quietDay?: boolean;
  };
};

export function fixturePack(spec: EvalFixture['packs'][number]): ContextPack {
  return {
    pack_version: '1.0',
    identity: {
      project_id: spec.project_id,
      name: spec.name,
      owner_description: `${spec.name} is one of the owner's projects.`,
      audience: 'their users',
    },
    stakes: {
      tier: spec.tier,
      has_external_users: spec.tier === 'live_small' || spec.tier === 'live_critical',
      touches_money: spec.touches_money ?? false,
      ...(spec.downtime_translation ? { downtime_translation: spec.downtime_translation } : {}),
    },
    topology: {
      sources: [{ connector: 'github', resource_id: spec.resource_id, role: 'source_of_truth' }],
      ...(spec.capability_gap
        ? { capability_gaps: [{ gap: 'gap', summary: spec.capability_gap }] }
        : {}),
    },
    baselines: {
      deploy_cadence: 'weekly',
      ...(spec.known_flaky ? { known_flaky: [{ pattern: spec.known_flaky, note: 'flaky, usually passes on retry' }] } : {}),
    },
    state: spec.has_deployed_before === false ? {} : { serving_now: { deployed_at: '2026-07-01T00:00:00Z', healthy: true } },
    trust: spec.degraded_trust
      ? { sources: { github: { status: 'stale_suspected', note: 'repo quiet while deploys continue' } }, overall_confidence: 'partial' }
      : { overall_confidence: 'high' },
    voice: { detail_level: spec.detail_level ?? 'plain_expandable', notify: { push_threshold: 'failures' } },
  };
}

const loom = {
  project_id: 'loom',
  name: 'Loom',
  tier: 'live_critical' as StakesTier,
  touches_money: true,
  resource_id: 'acme/loom',
  downtime_translation: "the retailers can't submit or check orders",
};
const mirror = { project_id: 'mirror', name: 'Mirror', tier: 'live_small' as StakesTier, resource_id: 'acme/mirror' };
const toile = { project_id: 'toile', name: 'Toile', tier: 'personal' as StakesTier, resource_id: 'acme/toile' };
const yoke = {
  project_id: 'yoke',
  name: 'YOKE',
  tier: 'live_small' as StakesTier,
  resource_id: 'acme/yoke',
  capability_gap: 'day 12 of visitors being unable to buy',
};

const sb = {
  project_id: 'sb-master',
  name: 'Smith Bespoke',
  tier: 'live_critical' as StakesTier,
  touches_money: true,
  resource_id: 'acme/sb-master',
  downtime_translation: 'clients cannot reach the storefront or their closets',
};
const cag = {
  project_id: 'cag-web',
  name: 'CAG site',
  tier: 'live_small' as StakesTier,
  resource_id: 'acme/cag-web',
  downtime_translation: 'the public site is dark and overnight leads may be lost',
};

export const FIXTURES: EvalFixture[] = [
  // --- Golden-aligned fixtures: approximate each golden's frozen inputs
  // with the Phase 1 event vocabulary where that's possible. mixed-day and
  // degraded-trust-day goldens describe events (first real transactions, a
  // stuck GPU scan) that no current connector can produce — their style
  // grading runs against the nearest synthetic fixture instead, and
  // first-day's orientation brief is a composer mode that doesn't exist
  // yet (flagged in the runner).
  {
    name: 'golden-quiet-day',
    description: "Golden quiet-day's frozen shape: 8 healthy projects, YOKE gap drumbeat, nothing else.",
    packs: [
      loom,
      mirror,
      toile,
      yoke,
      sb,
      cag,
      { project_id: 'sild', name: 'SILD', tier: 'live_critical', touches_money: true, resource_id: 'acme/sild' },
      { project_id: 'chalk', name: 'Chalk', tier: 'live_small', resource_id: 'acme/chalk' },
    ],
    events: [],
    expect: { quietDay: true },
  },
  {
    name: 'golden-storm-day',
    description: "Golden storm-day's frozen shape: one shared outage takes three apps down, all recover, flaky noise dropped.",
    packs: [loom, sb, cag, { ...toile, known_flaky: 'nightly' }],
    events: [
      { event_type: 'runtime.health_failing', resource_id: 'acme/loom', hour: 2 },
      { event_type: 'runtime.health_failing', resource_id: 'acme/sb-master', hour: 2 },
      { event_type: 'runtime.health_failing', resource_id: 'acme/cag-web', hour: 2 },
      { event_type: 'runtime.recovered', resource_id: 'acme/loom', hour: 4 },
      { event_type: 'runtime.recovered', resource_id: 'acme/sb-master', hour: 4 },
      { event_type: 'runtime.recovered', resource_id: 'acme/cag-web', hour: 4 },
      { event_type: 'build.failed', resource_id: 'acme/toile', hour: 3, raw: { workflow_run: { name: 'nightly build' } } },
    ],
    expect: {},
  },
  {
    name: 'quiet-day',
    description: 'Nothing happened; the brief still sends and stays small.',
    packs: [loom, mirror, toile],
    events: [],
    expect: { quietDay: true },
  },
  {
    name: 'single-failure-day',
    description: 'One live_critical deploy failure with previous version serving (B6).',
    packs: [loom, mirror],
    events: [{ event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'build-failed-day',
    description: 'A live_critical CI failure (B4): users are fine, verdict must survive.',
    packs: [loom],
    events: [{ event_type: 'build.failed', resource_id: 'acme/loom', raw: { workflow_run: { name: 'CI' } } }],
    expect: {},
  },
  {
    name: 'nothing-serving-day',
    description: 'First deploy dies with nothing serving (B7): users_affected must survive.',
    packs: [{ ...loom, has_deployed_before: false }],
    events: [{ event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'mixed-day',
    description: 'A failure, a ship, and a PR across three projects.',
    packs: [loom, mirror, toile],
    events: [
      { event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom', hour: 9 },
      { event_type: 'build.succeeded', resource_id: 'acme/mirror', hour: 11 },
      { event_type: 'code.pr_opened', resource_id: 'acme/toile', hour: 14 },
    ],
    expect: {},
  },
  {
    name: 'storm-day',
    description: 'Six live_critical failures — storm mode triages to 3 attention items.',
    packs: [loom],
    events: Array.from({ length: 6 }, (_, i) => ({
      event_type: 'build.failed',
      resource_id: 'acme/loom',
      hour: 8 + i,
      raw: { workflow_run: { name: `CI shard ${i}` } },
    })),
    expect: { stormMode: true },
  },
  {
    name: 'degraded-trust-day',
    description: 'A failure on a project whose repo trust is stale_suspected.',
    packs: [{ ...loom, degraded_trust: true }, mirror],
    events: [{ event_type: 'build.failed', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'first-day',
    description: 'First-ever brief: no previous digest, a single quiet ship.',
    packs: [loom, yoke],
    events: [{ event_type: 'build.succeeded', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'bad-news-only-day',
    description: 'Two failures, nothing moved; no forced positivity.',
    packs: [loom, mirror],
    events: [
      { event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom', hour: 9 },
      { event_type: 'build.failed', resource_id: 'acme/mirror', hour: 15, raw: { workflow_run: { name: 'CI' } } },
    ],
    expect: {},
  },
  {
    name: 'thread-closure-day',
    description: "Yesterday's Loom failure went quiet — the thread must close.",
    packs: [loom, mirror],
    events: [{ event_type: 'build.succeeded', resource_id: 'acme/mirror' }],
    previousOpenThreads: [{ project_id: 'loom', summary: "Loom's deploy failed" }],
    expect: { closedThreadProjects: ['Loom'] },
  },
  {
    name: 'thread-still-open-day',
    description: "Yesterday's thread project fails again — it must NOT be closed.",
    packs: [loom],
    events: [{ event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom' }],
    previousOpenThreads: [{ project_id: 'loom', summary: "Loom's deploy failed" }],
    expect: { closedThreadProjects: [] },
  },
  {
    name: 'capability-gap-day',
    description: "YOKE's standing gap line rides along with a quiet day elsewhere.",
    packs: [loom, yoke],
    events: [{ event_type: 'build.succeeded', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'shipped-day',
    description: 'Two ships, nothing broken — movement is the good news.',
    packs: [loom, mirror],
    events: [
      { event_type: 'build.succeeded', resource_id: 'acme/loom', hour: 9 },
      { event_type: 'build.succeeded', resource_id: 'acme/mirror', hour: 16 },
    ],
    expect: {},
  },
  {
    name: 'stall-nudge-day',
    description: 'A branch crossed the stall threshold (A5) — gentle standing nudge.',
    packs: [loom],
    events: [{ event_type: 'code.branch_stalled', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'migration-cannot-tell-day',
    description: "A DB migration failed (C4): cannot_tell must survive with what's being checked.",
    packs: [loom],
    events: [{ event_type: 'data.migration_failed', resource_id: 'acme/loom' }],
    expect: {},
  },
  {
    name: 'plain-only-register-day',
    description: 'Same failure at plain_only register — verdict identical, no technical line leaks.',
    packs: [{ ...loom, detail_level: 'plain_only' as DetailLevel }],
    events: [{ event_type: 'deploy.failed_previous_serving', resource_id: 'acme/loom' }],
    expect: {},
  },
];
