import type { ContextPack } from '../../shared/types/pack.js';

/**
 * The protection brief — what a customer receives when they connect an app
 * (BUILD-BRIEF Phase 1: "connect in under ten minutes, receive a brief worth
 * showing someone"). Distinct from the daily digest: a one-time, plain-English
 * account of what this app is, what Selvedge can and cannot see yet, where the
 * blind spots are, and the single most valuable thing to connect next.
 *
 * Deterministic and pure — it always produces a brief, with no model call. The
 * voice is a later optional layer over this, exactly as the mechanical digest
 * precedes the composed one. The honesty rules of the whole product apply here
 * hardest, because this is a stranger's first impression: name the blind spots,
 * never claim coverage that isn't there, and speak in plain words (no infra
 * nouns at the top level — "your data", not "your Supabase database").
 */

/** Whether each thing Selvedge watches is actually connected for this app. */
export type Coverage = {
  /** Code & changes — the GitHub connection. */
  code: boolean;
  /** Whether the app is actually running — the host connection (Railway/Vercel). */
  runtime: boolean;
  /** The data — the database connection (Supabase/Neon). */
  data: boolean;
};

export type CoverageArea = {
  area: 'code' | 'runtime' | 'data';
  connected: boolean;
  /** Plain sentence: what this covers when on, or what the blind spot is when off. */
  line: string;
};

export type ProtectionBrief = {
  appName: string;
  /** One plain sentence about what the app is and what's at stake. */
  whatItIs: string;
  coverage: CoverageArea[];
  /** The honest unknowns — what Selvedge cannot see yet, named. */
  blindSpots: string[];
  /** The single most valuable next connection, in plain words. Null when fully covered. */
  nextStep: string | null;
  /** How complete the picture is. Never overstated. */
  confidence: 'high' | 'partial' | 'low';
  /** The one-line verdict at the top of the brief. */
  headline: string;
};

function stakesSentence(pack: ContextPack): string {
  const bits: string[] = [];
  if (pack.stakes.touches_money) bits.push('takes payments');
  if (pack.stakes.has_external_users) bits.push('has real users');
  const name = pack.identity.name;
  const desc = pack.identity.owner_description?.trim();
  const base = desc ? `${name} — ${desc}` : name;
  if (bits.length === 0) return `${base}.`;
  return `${base}. It ${bits.join(' and ')}, so mistakes here matter.`;
}

/** What each area covers when connected, and what the blind spot is when not. */
const AREA_LINES: Record<
  CoverageArea['area'],
  { on: string; off: string; blindSpot: string; nextStep: string }
> = {
  code: {
    on: "I can see every change to your app's code and every deploy.",
    off: "I can't see changes to your app yet.",
    blindSpot: "I can't yet tell you when a change is what broke something.",
    nextStep: "Connect your app's code so I can see what changes.",
  },
  runtime: {
    on: 'I can see whether your app is actually up and serving people.',
    off: "I can't yet see whether your app is up — only whether its last build passed.",
    blindSpot: "If your app goes down but the last build was fine, I won't know yet.",
    nextStep: 'Connect your hosting so I can see whether your app is really running.',
  },
  data: {
    on: 'I can watch your data — so I can catch it quietly going missing.',
    off: "I can't see your data yet.",
    blindSpot: "If records stop saving while the app still looks fine, I won't catch it yet — that's the one that hurts most.",
    nextStep: 'Connect your data so I can catch silent loss before you do.',
  },
};

/** The order we recommend connecting things, most valuable first. */
const AREA_PRIORITY: CoverageArea['area'][] = ['data', 'runtime', 'code'];

export function composeProtectionBrief(pack: ContextPack, coverage: Coverage): ProtectionBrief {
  const areas: CoverageArea[] = (['code', 'runtime', 'data'] as const).map((area) => ({
    area,
    connected: coverage[area],
    line: coverage[area] ? AREA_LINES[area].on : AREA_LINES[area].off,
  }));

  const blindSpots = (['code', 'runtime', 'data'] as const)
    .filter((area) => !coverage[area])
    .map((area) => AREA_LINES[area].blindSpot);

  // The single most valuable next connection, by priority. Null when covered.
  const missingByPriority = AREA_PRIORITY.filter((area) => !coverage[area]);
  const nextArea = missingByPriority[0];
  const nextStep = nextArea ? AREA_LINES[nextArea].nextStep : null;

  const connectedCount = Number(coverage.code) + Number(coverage.runtime) + Number(coverage.data);
  const confidence: ProtectionBrief['confidence'] =
    connectedCount === 3 ? 'high' : connectedCount === 0 ? 'low' : 'partial';

  const headline =
    connectedCount === 3
      ? `I'm watching all of ${pack.identity.name} — code, uptime, and data.`
      : connectedCount === 0
        ? `I'm set up for ${pack.identity.name}, but I can't see much yet — here's the first thing to connect.`
        : `I'm watching part of ${pack.identity.name}. Here's what I can see, and what I still can't.`;

  return {
    appName: pack.identity.name,
    whatItIs: stakesSentence(pack),
    coverage: areas,
    blindSpots,
    nextStep,
    confidence,
    headline,
  };
}

/**
 * Derive coverage from a pack's topology and the set of connectors that
 * actually resolved a token for this org. A source in the pack is only "really
 * connected" if we can also act on it — a repo we can read (code) is enough for
 * code; runtime and data need a live token, because the pack listing a host or
 * database we can't reach is exactly the false-coverage we must not claim.
 */
export function coverageFromPack(
  pack: ContextPack,
  connected: { host: boolean; database: boolean },
): Coverage {
  const sources = pack.topology.sources ?? [];
  const hasCode = sources.some((s) => s.connector === 'github');
  return {
    code: hasCode,
    runtime: connected.host,
    data: connected.database,
  };
}
