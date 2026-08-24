import type { ContextPack } from '../../shared/types/pack.js';
import type { NarratableEvent } from './types.js';

/** The owner's own name for the project — digest-composer voice rule 4. */
export function projectName(pack: ContextPack): string {
  return pack.identity.name;
}

/**
 * WHAT BEING DOWN MEANS FOR THIS BUSINESS, IN THE OWNER'S OWN WORDS.
 *
 * A NOUN PHRASE, not a sentence: "orders stop going through", "bookings can't
 * be taken". The templates read it as a clause inside a larger sentence, which
 * is why the shape matters.
 *
 * IT RETURNS NULL RATHER THAN A GENERIC, and that is the fix for two sentences
 * that shipped to a real screen. The fallback used to be "the people who use
 * it are affected" — a full sentence wearing a noun phrase's clothes — and it
 * produced both of these:
 *
 *   "AI Chess looks down right now — users are affected: the people who use
 *    it are affected."
 *   "AI Chess: your update couldn't go live. The previous version is still
 *    running — users are fine, and the people who use it are affected is not
 *    happening."
 *
 * The first says one thing twice, because the generic is a restatement of the
 * verdict phrase it was appended to. The second is not grammatical in any
 * dialect.
 *
 * An owner who has not written down what downtime costs them has told us
 * nothing about it, and there is no honest generic for that — every candidate
 * either repeats the verdict or invents a consequence. So the clause is
 * omitted and the sentence is shorter. Saying less is always available; saying
 * something that isn't true is not.
 */
export function downtimeTranslation(pack: ContextPack): string | null {
  return pack.stakes.downtime_translation?.trim() || null;
}

export function audience(pack: ContextPack): string {
  return pack.identity.audience || (pack.stakes.has_external_users ? 'your users' : 'just you');
}

/** The collapsed technical line for plain_expandable / technical_forward — built from structured fields only, never `raw`. */
export function technicalLine(event: NarratableEvent): string {
  return `event: ${event.event_type} · occurred ${event.occurred_at} · id ${event.id}`;
}
