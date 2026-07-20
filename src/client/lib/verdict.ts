import type { EdgeStatus } from '../components/SelvedgeEdge.js';

/**
 * The fixed verdict vocabulary (Phase 2) mapped onto the edge vocabulary
 * ("The Look", Prompt 3). This mapping is a rule, not a choice:
 *   users_fine     → healthy
 *   users_affected → needs (thread)
 *   cannot_tell    → unknown (dashed) — NEVER healthy, never neutral-gray-solid
 */
export type Verdict = 'users_affected' | 'users_fine' | 'cannot_tell';

export function verdictToStatus(verdict: Verdict): EdgeStatus {
  switch (verdict) {
    case 'users_fine':
      return 'healthy';
    case 'users_affected':
      return 'needs';
    case 'cannot_tell':
      return 'unknown';
  }
}
