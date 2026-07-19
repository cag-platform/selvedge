import type { SeverityHint } from '../../shared/types/event.js';

export type Verdict = 'users_affected' | 'users_not_affected' | 'cant_tell_yet';

/**
 * The structured, non-`raw` slice of a stored event that templates may
 * read. Deliberately excludes `raw` — nothing downstream of the connector
 * layer touches it (deliverable 1).
 */
export type NarratableEvent = {
  id: string;
  event_type: string;
  occurred_at: string;
  severity_hint: SeverityHint;
};

export type NarrationOutput = {
  /** The plain_only sentence(s). Never empty for a non-SILENT row. */
  fragment: string;
  /** plain_expandable/technical_forward only: a collapsed line built from structured event fields (never `raw`). */
  technicalDetail?: string;
  verdict?: Verdict;
};

/**
 * A template is a pure function of the event + pack + routing decision.
 * This is the seam Phase 2 replaces with an LLM call: same inputs, same
 * NarrationOutput shape, different implementation behind narrate().
 */
export type TemplateFn = (event: NarratableEvent, pack: import('../../shared/types/pack.js').ContextPack) => NarrationOutput;
