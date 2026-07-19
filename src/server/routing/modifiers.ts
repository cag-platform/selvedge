import type { ContextPack } from '../../shared/types/pack.js';
import type { Delivery, IntendedPath, RoutingContext, TierDecision } from './types.js';

/** Mutable working state modifiers act on before the final decision is frozen. */
export type WorkingDecision = {
  intended_path: IntendedPath;
  delivery: Delivery;
  quiet_hours_override: boolean;
};

const LEVELS: Delivery[] = ['NONE', 'DIGEST', 'PUSH'];

function demote(delivery: Delivery): Delivery {
  const i = LEVELS.indexOf(delivery);
  return LEVELS[Math.max(0, i - 1)] as Delivery;
}

function upgrade(delivery: Delivery): Delivery {
  const i = LEVELS.indexOf(delivery);
  return LEVELS[Math.min(LEVELS.length - 1, i + 1)] as Delivery;
}

/** Rows Group E treats as allowed to push under push_threshold=critical_only besides ⚡ rows. */
const CRITICAL_ONLY_ALLOWED_ROWS = new Set(['C1', 'C4', 'C6']);
/** Rows that aren't themselves a "failure" — capped under push_threshold=failures. */
const NON_FAILURE_ROWS = new Set(['C2', 'D1', 'D2']);

export function toWorkingDecision(tier: TierDecision): WorkingDecision {
  return {
    intended_path: tier.path,
    delivery: tier.delivery,
    quiet_hours_override: tier.quiet_hours_override ?? false,
  };
}

/**
 * Global modifier 5 (doc §Global modifiers): "matching pattern demotes any
 * B/C row one delivery level and forces TEMPLATE." Applies across any row,
 * not just B5, because a caller may have matched known_flaky against an
 * event whose row is B4/B6/C1/etc.
 */
export function applyKnownFlakyDowngrade(
  decision: WorkingDecision,
  context: RoutingContext,
  modifiers: string[],
): void {
  if (!context.matchedKnownFlaky) return;
  if (decision.intended_path === 'SILENT') return;
  decision.intended_path = 'TEMPLATE';
  decision.delivery = demote(decision.delivery);
  modifiers.push('known_flaky_downgrade');
}

/**
 * Global modifier 4: dormancy "never upgrades delivery except C1/C4" — i.e.
 * for those two rows specifically, a dormant project's health/migration
 * failure can escalate a DIGEST-tier decision to PUSH.
 */
export function applyDormancyInversion(
  decision: WorkingDecision,
  rowId: string,
  pack: ContextPack,
  modifiers: string[],
): void {
  const dormant = pack.baselines?.deploy_cadence === 'dormant';
  if (!dormant) return;
  if (rowId !== 'C1' && rowId !== 'C4') return;
  if (decision.delivery !== 'DIGEST') return;
  decision.delivery = upgrade(decision.delivery);
  modifiers.push('dormancy_upgrade');
}

/**
 * Global modifier 6: more than 5 push-worthy events for one project within
 * 15 minutes collapse into a single push; everything past the 5th folds
 * into the digest instead of machine-gunning the user. The resolution
 * layer is responsible for emitting the one collapsed summary push.
 */
export function applyStormCollapse(decision: WorkingDecision, context: RoutingContext, modifiers: string[]): void {
  if ((context.recentPushWorthyCount ?? 0) < 5) return;
  if (decision.delivery !== 'PUSH') return;
  decision.delivery = demote(decision.delivery);
  modifiers.push('storm_collapsed');
}

/** Local "HH:MM" -> minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function withinQuietHours(currentLocalTime: string, start: string, end: string): boolean {
  const cur = toMinutes(currentLocalTime);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false; // zero-width window, never quiet
  if (s < e) return cur >= s && cur < e;
  return cur >= s || cur < e; // wraps midnight, e.g. 22:00 - 07:00
}

/**
 * Global modifier 2: PUSH defers to the next digest during quiet hours,
 * except ⚡ rows (quiet_hours_override).
 */
export function applyQuietHours(decision: WorkingDecision, pack: ContextPack, context: RoutingContext, modifiers: string[]): void {
  if (decision.delivery !== 'PUSH') return;
  if (decision.quiet_hours_override) return;
  const window = pack.voice.notify?.quiet_hours_local;
  if (!window?.start || !window.end || !context.currentLocalTime) return;
  if (!withinQuietHours(context.currentLocalTime, window.start, window.end)) return;
  decision.delivery = demote(decision.delivery);
  modifiers.push('quiet_hours_deferred');
}

/**
 * Global modifier 1: push_threshold caps delivery downward. This is the
 * last modifier applied and the only one with veto power — "a `never`
 * project can't push, period" (brief, routing table intro).
 */
export function applyPushThresholdCap(decision: WorkingDecision, rowId: string, pack: ContextPack, modifiers: string[]): void {
  if (decision.delivery !== 'PUSH') return;
  const threshold = pack.voice.notify?.push_threshold ?? 'failures';

  if (threshold === 'never') {
    decision.delivery = demote(decision.delivery);
    modifiers.push('push_threshold_never');
    return;
  }
  if (threshold === 'critical_only') {
    const allowed = decision.quiet_hours_override || CRITICAL_ONLY_ALLOWED_ROWS.has(rowId);
    if (!allowed) {
      decision.delivery = demote(decision.delivery);
      modifiers.push('push_threshold_critical_only');
    }
    return;
  }
  if (threshold === 'failures') {
    if (NON_FAILURE_ROWS.has(rowId)) {
      decision.delivery = demote(decision.delivery);
      modifiers.push('push_threshold_failures_only');
    }
    return;
  }
  // 'everything' — most permissive; no cap.
}
