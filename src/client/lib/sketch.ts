/**
 * Sketch's view rules, kept pure so they can be tested (the pages themselves
 * are not). The one rule worth defending here: a sketch is only offered as
 * buildable when there is an actual brief behind the button.
 */

export type SketchMessageData = { id: string; role: 'owner' | 'sketch'; content: string; at: string };

export type SketchData = {
  id: string;
  title: string;
  project_id: string | null;
  brief: string | null;
  ready: boolean;
  handed_off_at: string | null;
};

export type SketchListItem = {
  id: string;
  title: string;
  project_id: string | null;
  ready: boolean;
  handed_off_at: string | null;
  updated_at: string;
};

export type SketchCost = { today_usd: number; cap_usd: number };

/** Dollars, plainly. Sketch spend is small enough that cents matter. */
export function formatUsd(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}

/**
 * Can this be handed to the workshop? Never on `ready` alone — a ready flag
 * with no brief behind it would be a button that builds nothing.
 */
export function canBuild(sketch: Pick<SketchData, 'ready' | 'brief'>): boolean {
  return sketch.ready && typeof sketch.brief === 'string' && sketch.brief.trim() !== '';
}

/** What the list says about where an idea has got to. */
export function sketchStatus(item: Pick<SketchListItem, 'ready' | 'handed_off_at'>): string {
  if (item.handed_off_at) return 'Building';
  return item.ready ? 'Ready to build' : 'Thinking';
}

/**
 * How close the day's thinking budget is to spent. Returns null when there's
 * no cap to speak of, so the header can stay quiet rather than show "$0.00 of
 * $0.00" when the lookup degraded.
 */
export function budgetNote(cost: SketchCost): string | null {
  if (!Number.isFinite(cost.cap_usd) || cost.cap_usd <= 0) return null;
  return `${formatUsd(cost.today_usd)} of ${formatUsd(cost.cap_usd)} today`;
}
