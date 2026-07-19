import type { Db } from '../db/client.js';
import type { ContextPack } from '../../shared/types/pack.js';
import type { RoutingDecision } from '../routing/types.js';
import type { LlmClient } from '../llm/types.js';
import { llmEnabled } from '../llm/config.js';
import { narrate } from './narrate.js';
import { llmFragmentCall } from './llmFragment.js';
import type { NarratableEvent, NarrationOutput } from './types.js';

/**
 * A library hit ready to serve, or a place to write a new candidate.
 * Implemented against the DB in narration/library.ts (deliverable 4);
 * dispatch only knows this port so it stays testable in isolation.
 */
export interface NarrationLibraryPort {
  lookup(
    orgId: string,
    event: NarratableEvent,
    pack: ContextPack,
  ): Promise<{ output: NarrationOutput; source: 'glossary' | 'library'; fingerprint: string } | null>;
  writeCandidate(orgId: string, event: NarratableEvent, pack: ContextPack, output: NarrationOutput): Promise<void>;
  /** The fingerprint this event would file under — persisted in narrations.meta so feedback taps can retire the entry. */
  fingerprint(event: NarratableEvent, pack: ContextPack): string;
}

export type NarrationDeps = {
  llm: LlmClient;
  db: Db;
  library?: NarrationLibraryPort;
};

export type DispatchResult = {
  output: NarrationOutput;
  /** The narration path actually taken this call. */
  path: 'TEMPLATE' | 'LIB' | 'LLM' | 'LLM+VERDICT';
  /** Diagnostics persisted into narrations.meta — feeds lib_hit_rate, fallback metrics, and feedback-tap retirement. */
  meta: { lib_hit?: boolean; fallback_reason?: string; confidence?: string; fingerprint?: string };
};

/**
 * Phase 2's implementation of the narration interface — honors the routing
 * decision's intended_path instead of collapsing everything to TEMPLATE:
 *
 *   TEMPLATE     -> registry (unchanged Phase 1 path)
 *   LIB          -> graduation-library lookup -> fallback LLM on miss
 *   LLM          -> fragment call with the pack's narrator context
 *   LLM+VERDICT  -> fragment call; a response without a verdict is a failure
 *
 * Every LLM failure — timeout, refusal, missing verdict, bad JSON — falls
 * back to the Phase 1 template for that event and records the miss. With no
 * deps (or no API key), behavior is exactly Phase 1.
 */
export async function narrateDispatch(
  event: NarratableEvent,
  pack: ContextPack,
  decision: RoutingDecision,
  deps?: NarrationDeps,
  collapseSiblings: Array<{ event_type: string; occurred_at: string }> = [],
): Promise<DispatchResult | null> {
  if (decision.path === 'SILENT') return null;

  const templateOutput = () => narrate(event, pack, decision);

  const voiceOff = !deps || !llmEnabled();
  // decision.path !== 'SILENT' implies intended_path !== 'SILENT'; narrow for the compiler.
  const intended = decision.intended_path as 'TEMPLATE' | 'LIB' | 'LLM' | 'LLM+VERDICT';

  if (intended === 'TEMPLATE' || voiceOff) {
    const output = templateOutput();
    if (!output) return null;
    const fallbackBecauseVoiceOff = voiceOff && intended !== 'TEMPLATE';
    return {
      output,
      path: 'TEMPLATE',
      meta: fallbackBecauseVoiceOff ? { fallback_reason: 'llm_disabled' } : {},
    };
  }

  const requireVerdict = intended === 'LLM+VERDICT';
  const fingerprint = intended === 'LIB' && deps.library ? deps.library.fingerprint(event, pack) : undefined;

  if (intended === 'LIB' && deps.library) {
    const hit = await deps.library.lookup(event.org_id ?? '', event, pack);
    if (hit) {
      return { output: hit.output, path: 'LIB', meta: { lib_hit: true, fingerprint: hit.fingerprint } };
    }
  }

  const orgId = event.org_id ?? '';
  const result = await llmFragmentCall(deps, orgId, event, pack, requireVerdict, collapseSiblings);

  if (!result.ok) {
    const output = templateOutput();
    if (!output) return null;
    return {
      output,
      path: 'TEMPLATE',
      meta: { fallback_reason: result.reason, ...(intended === 'LIB' ? { lib_hit: false } : {}) },
    };
  }

  // Every successful LLM fragment on a LIB row seeds a library candidate.
  if (intended === 'LIB' && deps.library) {
    await deps.library.writeCandidate(orgId, event, pack, result.output);
  }

  return {
    output: result.output,
    path: intended,
    meta: {
      confidence: result.confidence,
      ...(intended === 'LIB' ? { lib_hit: false } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    },
  };
}
