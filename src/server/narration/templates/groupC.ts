import { downtimeTranslation, projectName, technicalLine } from '../slots.js';
import { VERDICT_PHRASE } from '../verdictText.js';
import type { TemplateFn } from '../types.js';

/**
 * Group C templates exist for completeness and future host/DB connectors —
 * no Phase 1 connector produces these event types (see the "no host/DB
 * connectors" non-goal), so they're untriggered in production today but
 * kept exercised in tests so the narration layer is ready for the swap.
 */

// VOICE-REVIEW
export const C1: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} looks down right now — ${VERDICT_PHRASE.users_affected}: ${downtimeTranslation(pack)}.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_affected',
});

export const C2: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} is back up — ${VERDICT_PHRASE.users_fine}.`,
  technicalDetail: technicalLine(event),
  verdict: 'users_fine',
});

// VOICE-REVIEW: addendum to C2 per the routing doc, not a standalone item —
// callers append this to the C2 fragment when the pack notes a hidden
// dependency (e.g. Postgres-as-queue). Phase 1 renders it as its own line.
export const C3: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)} is back — worth checking that anything queued in the background resumed.`,
  technicalDetail: technicalLine(event),
});

// VOICE-REVIEW: cannot_tell must say what's being checked (brief, deliverable 3).
export const C4: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a database migration failed. I ${VERDICT_PHRASE.cannot_tell} whether users are affected — checking whether the schema half-applied.`,
  technicalDetail: technicalLine(event),
  verdict: 'cannot_tell',
});

export const C5: TemplateFn = (event, pack) => ({
  fragment: `${projectName(pack)}: a database resource limit is getting close — worth a look this week.`,
  technicalDetail: technicalLine(event),
});
