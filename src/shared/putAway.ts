/**
 * PUT AWAY — a place you are not working in right now.
 *
 * The rail is one list of everywhere you work, ordered by what needs you. That
 * is the right list for four projects and the wrong one for forty: a repo you
 * finished in March is not a thing that needs you, but it sits in the list
 * making the list longer, and a list you scroll past is a list you stop
 * reading. The rail's whole job is that a stranger can read the stack from it,
 * and eleven dormant rows cost that more than any missing feature does.
 *
 * So a place can be put away. It leaves the rail. It is not deleted, not
 * unwatched, not un-referenceable: `#`-pointing at it still works, its history
 * is still there, its conversation is exactly where it was.
 *
 * WHAT IS DELIBERATELY NOT DONE. Putting a place away does not raise it back
 * when it goes red. That was tempting — "it comes back if it needs you" sounds
 * more honest — but it is the opposite: it overrides a decision the owner
 * made, on exactly the projects they told us not to bother them about, and it
 * would make the feature useless for the case it exists for (a dead repo whose
 * deploy has been failing since spring).
 *
 * WHAT IS NEVER HIDDEN IS THE COUNT. The rail always says how many places are
 * put away, and one tap brings them back into view with their health lines
 * intact. Nothing vanishes; something is folded, and the fold is labelled. A
 * hidden row claims nothing, but a hidden row you can't find out about is a
 * product lying about its own size.
 *
 * WHERE THE STATE LIVES. No new column: a project put away is `packs.muted_at`
 * (which already meant "deprioritised" and already drops it out of the
 * digest), and a subject put away is `subjects.archived_at` (already
 * reversible, and its own router calls it "put it away"). Two tables, one
 * meaning. A third state for a thing two columns already said would be a
 * second way to say one thing.
 */

/** How the rail names the fold. Singular where singular is right. */
export function putAwayLine(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 put away' : `${count} put away`;
}

/** The verbs, in one place so both clients use the same two words. */
export const PUT_AWAY = 'Put away';
export const BRING_BACK = 'Bring back';

/**
 * What the fold says when opened, for the case that is otherwise puzzling: a
 * put-away place whose conversation is the one you were last in.
 */
export const PUT_AWAY_NOTE = 'These stay out of the rail until you bring them back. Nothing about them is deleted or stops being watched.';
