import type { ContextPack } from '../../shared/types/pack.js';

export type ProjectStatus = 'healthy' | 'working' | 'needs' | 'unknown';

/**
 * The single source of truth for a project's card status. BOTH the edge color
 * (`edgeStatus`) and the plain sentence (`healthLine`) derive from this, so the
 * seam and the words can never disagree — the earlier split (edge keyed off
 * `state.in_progress`, sentence keyed off `capability_gaps`) let a gapped-but-
 * healthy project show a green edge next to a "Healthy — {gap}" line, which
 * undercuts the whole "read the edges" thesis.
 *
 * Priority (false-calm first): a confirmed-down signal, then "can't verify at
 * all" (low), then a known capability gap (a real unmet thing worth the edge →
 * working/brass, not a calm green), then partial/absent health signal
 * (unknown/dashed — never guessed calm), then work in flight, else healthy.
 *
 * Judgment call baked in here: a `capability_gap` reads as `working`, not
 * `healthy`. A gap like "day 12 of visitors being unable to buy" is a real
 * standing problem; the edge must not be green.
 */
export function deriveProjectStatus(pack: ContextPack): ProjectStatus {
  const healthy = pack.state?.serving_now?.healthy;
  const confidence = pack.trust?.overall_confidence;

  if (healthy === false) return 'needs';
  if (confidence === 'low') return 'unknown';
  if ((pack.topology.capability_gaps ?? []).length > 0) return 'working';
  if (confidence === 'partial') return 'unknown';
  if (healthy === null || healthy === undefined) return 'unknown';
  if ((pack.state?.in_progress ?? []).length > 0) return 'working';
  return 'healthy';
}

/**
 * HAS ANYTHING ACTUALLY REPORTED ON THIS PROJECT'S HEALTH?
 *
 * "I looked and couldn't tell" and "nothing has ever reported" are different
 * facts, and collapsing them is what made every project in the rail apologise
 * at once: eight rows of "No health signal yet." under eight dashed edges,
 * which reads as eight problems rather than one absence.
 *
 * A dashed edge is the false-calm guard — it means Selvedge looked at
 * something and could not vouch for it. Spending it on a project nobody has
 * ever sent a signal about spends the alarm on nothing, and an alarm that is
 * always on stops being read.
 *
 * So a project with no signal says NOTHING in the owner's lists: no line, no
 * edge, just its name. It is still watched, still workable, and the agent is
 * still told the health is unknown — see `healthLine`, which stays complete
 * for the model's context. This governs only what is put in front of a person.
 */
export function hasHealthSignal(pack: ContextPack): boolean {
  const healthy = pack.state?.serving_now?.healthy;
  if (healthy !== null && healthy !== undefined) return true;
  // A stated confidence problem IS a signal — it's Selvedge saying it looked.
  const confidence = pack.trust?.overall_confidence;
  if (confidence === 'low' || confidence === 'partial') return true;
  // So is a known gap: a real unmet thing somebody wrote down.
  return (pack.topology.capability_gaps ?? []).length > 0;
}

/**
 * The edge vocabulary for a project card ("The Look"). Derived from the one
 * status function above so it never disagrees with the health line.
 */
export function edgeStatus(pack: ContextPack): ProjectStatus {
  return deriveProjectStatus(pack);
}

/**
 * The Projects list "plain health line" per pack card (deliverable 8). Same
 * status as the edge; only the wording differs.
 */
export function healthLine(pack: ContextPack): string {
  const status = deriveProjectStatus(pack);
  const confidence = pack.trust?.overall_confidence;

  switch (status) {
    case 'needs':
      return 'Looks down right now.';
    case 'unknown':
      if (confidence === 'low') return "I can't verify this project's health right now.";
      if (confidence === 'partial') return "I can't fully verify this project's health right now.";
      return 'No health signal yet.';
    case 'working': {
      const gap = pack.topology.capability_gaps?.[0];
      if (gap) {
        // Only claim "Healthy" when health is actually confirmed; otherwise
        // surface the known gap without asserting a health we can't see.
        return pack.state?.serving_now?.healthy === true ? `Healthy — ${gap.summary}` : gap.summary;
      }
      return 'Healthy — work in progress.';
    }
    case 'healthy':
      return 'Healthy.';
  }
}
