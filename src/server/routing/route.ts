import type { ContextPack } from '../../shared/types/pack.js';
import { findRow } from './table.js';
import {
  applyDormancyInversion,
  applyKnownFlakyDowngrade,
  applyPushThresholdCap,
  applyQuietHours,
  applyStormCollapse,
  toWorkingDecision,
} from './modifiers.js';
import type { Path, RoutableEvent, RoutingContext, RoutingDecision } from './types.js';

function collapse(intendedPath: RoutingDecision['intended_path']): Path {
  return intendedPath === 'SILENT' ? 'SILENT' : 'TEMPLATE';
}

/**
 * Layer 3. Deterministic, side-effect-free: reads an event + a project's
 * context pack, returns where the resulting narration goes. Phase 1 collapses
 * LIB/LLM/LLM+VERDICT to TEMPLATE (no LLM calls exist yet) but always reports
 * the doc's original `intended_path` too, so Phase 2 swaps the narration
 * implementation behind this contract without touching routing.
 */
export function route(event: RoutableEvent, pack: ContextPack, context: RoutingContext = {}): RoutingDecision {
  const row = findRow(event.event_type);
  const tierDecision = row.tiers[pack.stakes.tier];
  if (!tierDecision) {
    throw new Error(`Routing row ${row.id} has no decision for tier "${pack.stakes.tier}"`);
  }

  const decision = toWorkingDecision(tierDecision);
  const modifiers: string[] = [];

  // Row-specific rule (doc §Group C, C2 notes): a recovery only pushes if
  // the outage it answers pushed. Not one of the five listed global
  // modifiers, but part of C2's own definition — applied before them.
  if (row.id === 'C2' && decision.delivery === 'PUSH' && !context.pairedOutagePushed) {
    decision.delivery = 'DIGEST';
    modifiers.push('recovery_requires_paired_push');
  }

  applyKnownFlakyDowngrade(decision, context, modifiers);
  applyDormancyInversion(decision, row.id, pack, modifiers);
  applyStormCollapse(decision, context, modifiers);
  applyQuietHours(decision, pack, context, modifiers);
  applyPushThresholdCap(decision, row.id, pack, modifiers);

  return {
    row_id: row.id,
    event_type: event.event_type,
    path: collapse(decision.intended_path),
    intended_path: decision.intended_path,
    delivery: decision.delivery,
    modifiers,
  };
}
