import type { ContextPack } from '../../shared/types/pack.js';
import type { RoutingDecision } from '../routing/types.js';
import { templateRegistry } from './templates/registry.js';
import type { NarratableEvent, NarrationOutput } from './types.js';

/**
 * Layer 4. Phase 1 implementation of the narration interface: a template
 * lookup keyed by the routing decision's row_id. Phase 2 swaps this
 * function's body for an LLM call (or a LIB-then-LLM fallback) without
 * changing its signature or what calls it — narrate(event, pack, decision)
 * stays the seam.
 */
export function narrate(event: NarratableEvent, pack: ContextPack, decision: RoutingDecision): NarrationOutput | null {
  if (decision.path === 'SILENT') return null;

  const template = templateRegistry[decision.row_id];
  if (!template) {
    throw new Error(`No template registered for routing row "${decision.row_id}" (event_type "${decision.event_type}")`);
  }

  const output = template(event, pack);

  // plain_only never carries the expandable technical line.
  if (pack.voice.detail_level === 'plain_only') {
    const { technicalDetail: _drop, ...rest } = output;
    return rest;
  }
  return output;
}
