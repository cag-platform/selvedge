import * as A from './groupA.js';
import * as B from './groupB.js';
import * as C from './groupC.js';
import * as E from './groupE.js';
import type { TemplateFn } from '../types.js';

/**
 * Keyed by routing-table.json row id — the same id the router already
 * resolved, so narrate() is a one-hop lookup. Rows with no entry here are
 * either SILENT at every tier (A1, B1 — never narrated) or org-level
 * (E1, E4 — see narration/orgLevel.ts), or outside Phase 1's v1_scope
 * (Group D, C6, F, G — G is standing narration composed directly by the
 * digest layer, not per-event). C7 (error_rate_spike) gained a producer with
 * the error beacon, so it now has a template.
 */
export const templateRegistry: Record<string, TemplateFn> = {
  A2: A.A2,
  A3: A.A3,
  A4: A.A4,
  A5: A.A5,
  A6: A.A6,
  B2: B.B2,
  B3: B.B3,
  B4: B.B4,
  B5: B.B5,
  B6: B.B6,
  B7: B.B7,
  C1: C.C1,
  C2: C.C2,
  C3: C.C3,
  C4: C.C4,
  C5: C.C5,
  C7: C.C7,
  E2: E.E2,
};
