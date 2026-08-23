/**
 * FUSION — the sentence this whole product was built to be able to say.
 *
 *   "Tuesday's checkout errors began after the change from Monday's Codex
 *    session (the guest-checkout work)."
 *
 * Correlation already gets from a break to the change before it. This gets from
 * that change to the WORK that produced it: the conversation someone had, in
 * Selvedge or in a terminal, hours earlier. It is sayable here because this is
 * the one window that holds both halves — the conversation and the outcome.
 *
 * WHICH IS EXACTLY WHY THE HONESTY RULES HERE ARE THE STRICTEST IN THE
 * CODEBASE. The sentence is impressive; a wrong one is a person spending their
 * morning reading the wrong diff, told to by a machine that sounded certain.
 * So:
 *
 *  1. NO ATTRIBUTION, NO SENTENCE. If the commits carry no session — nothing
 *     stamped, nothing the companion saw — this returns null and the existing
 *     "started right after new code landed" line stands alone. Reaching further
 *     for a plausible session is inventing one.
 *  2. AMBIGUITY IS NAMED, NEVER RESOLVED. Two sessions in the change means the
 *     sentence says two, and says it can't tell which. "Began after these three
 *     changes; I can't tell which" is a correct and shippable output.
 *  3. IT NEVER SAYS CAUSED. "Began after" is what the evidence supports —
 *     a commit landed, then something broke. That is a lead worth following,
 *     not a verdict, and the wording must never harden into one.
 */

export type SessionAttribution =
  | {
      kind: 'selvedge';
      /** The thread the work was asked for in. */
      threadId: string;
      title: string;
      agent: string;
      at: string;
      commit: string | null;
    }
  | {
      kind: 'observed';
      sessionId: string;
      agent: string;
      /** What was asked for, if the session said. */
      intent: string | null;
      at: string;
      commit: string | null;
    };

export type Fusion = {
  sentence: string;
  attributions: SessionAttribution[];
  /** True when more than one session could be behind this, and none of them is picked. */
  ambiguous: boolean;
};

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Monday's", "yesterday's", "earlier today" — how a person says when something
 * happened. Computed in UTC: the digest knows the owner's timezone and this
 * layer does not, so a day boundary can be a few hours off for someone far from
 * it. A wrong weekday is a cosmetic error; naming a session is the load-bearing
 * part, and it is exact.
 */
export function dayPhrase(at: Date, now: Date): string {
  const days = Math.floor((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return 'earlier today';
  if (days === 1) return "yesterday's";
  if (days < 7) return `${WEEKDAYS[at.getUTCDay()]}'s`;
  return `the ${at.getUTCDate()} ${at.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })}`;
}

function startOfDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** "three hours earlier" — for work on the same day, the distance is the useful fact. */
function gapPhrase(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 90) return `${minutes} minutes earlier`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours earlier`;
}

/**
 * How one session is named in the sentence.
 *
 * Same day as the break: the day name says nothing, so the gap does — "the
 * Codex session three hours earlier". Any other day: the day name is exactly
 * what a person would reach for — "Monday's Codex session".
 */
function describe(attribution: SessionAttribution, now: Date, agentName: (id: string) => string): string {
  const at = new Date(attribution.at);
  const when = dayPhrase(at, now);
  const sameDay = when === 'earlier today';
  const subject =
    attribution.kind === 'selvedge'
      ? // Work Selvedge itself ran: the thread has a name the owner gave it.
        `work in "${clip(attribution.title)}" here`
      : `${agentName(attribution.agent)} session${attribution.intent ? ` (${clip(attribution.intent)})` : ''}`;
  return sameDay ? `the ${subject}, ${gapPhrase(at, now)}` : `${when} ${subject}`;
}

/**
 * The sentence, or null. `now` is the moment the break happened — the reader is
 * being told about it in the next morning's brief, so "yesterday's" is relative
 * to the break, not to when they read it.
 */
export function composeFusion(
  attributions: SessionAttribution[],
  breakAt: Date,
  agentName: (id: string) => string = (id) => id,
): Fusion | null {
  if (attributions.length === 0) return null;

  if (attributions.length === 1) {
    const only = attributions[0]!;
    return {
      sentence: `This began after the change from ${describe(only, breakAt, agentName)}.`,
      attributions,
      ambiguous: false,
    };
  }

  // More than one session is behind the change that preceded this break. Naming
  // one of them would be a coin toss dressed as an answer.
  const named = attributions.slice(0, 3).map((a) => describe(a, breakAt, agentName));
  const rest = attributions.length - named.length;
  const list = rest > 0 ? `${named.join(', ')}, and ${rest} more` : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  return {
    sentence: `This began after changes from ${list} — I can't tell which.`,
    attributions,
    ambiguous: true,
  };
}
