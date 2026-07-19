import { downtimeTranslation, projectName, technicalLine } from '../slots.js';
import type { TemplateFn } from '../types.js';

/**
 * Group C templates exist for completeness and future host/DB connectors —
 * no Phase 1 connector produces these event types (see the "no host/DB
 * connectors" non-goal), so they're untriggered in production today but
 * kept exercised in tests so the narration layer is ready for the swap.
 */

// VOICE-REVIEW
export const C1: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} looks down right now — ${downtimeTranslation(pack)}.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_affected',
});

export const C2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} is back up.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_not_affected',
});

// VOICE-REVIEW: addendum to C2 per the routing doc, not a standalone item —
// callers append this to the C2 fragment when the pack notes a hidden
// dependency (e.g. Postgres-as-queue). Phase 1 renders it as its own line.
export const C3: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} is back — worth checking that anything queued in the background resumed.`,
  technicalDetail: technicalLine(event),
});

export const C4: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a database migration failed.`,
  technicalDetail: technicalLine(event),
  verdict: 'cant_tell_yet',
});

export const C5: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a database resource limit is getting close — worth a look this week.`,
  technicalDetail: technicalLine(event),
});
