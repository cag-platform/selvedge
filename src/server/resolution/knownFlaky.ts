import type { ContextPack } from '../../shared/types/pack.js';

/**
 * A DELIBERATE, NARROW exception to "nothing downstream of the connector
 * touches raw" (deliverable 1). known_flaky matching (routing doc's global
 * modifier 5) needs the failing workflow's name, which only exists in the
 * GitHub workflow_run payload — the fixed SelvedgeEvent envelope has no
 * structured field for it. Rather than invent one unilaterally, this reads
 * `raw` for this one purpose only, right here, and nowhere else in
 * resolution/routing/narration. Flagged in the PR description as a spot
 * where the envelope and the routing table's own requirements are in
 * tension — a good candidate for a future structured `event.subject` field.
 */
export function matchesKnownFlaky(raw: unknown, pack: ContextPack): boolean {
  const patterns = pack.baselines?.known_flaky ?? [];
  if (patterns.length === 0) return false;

  const workflowName = extractSignature(raw);
  if (!workflowName) return false;

  return patterns.some((p) => workflowName.toLowerCase().includes(p.pattern.toLowerCase()));
}

/**
 * Same narrow raw exception, second consumer (Phase 2): the graduation
 * library's error-class fingerprint needs the failing check/workflow name,
 * which only exists in the payload. Extracted here — alongside knownFlaky,
 * inside resolution — and passed to narration as event.signature, so the
 * narration layer itself still never touches raw.
 */
export function extractSignature(raw: unknown): string | undefined {
  return (raw as { workflow_run?: { name?: string } })?.workflow_run?.name ?? undefined;
}
