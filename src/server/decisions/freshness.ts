/**
 * HOW MUCH OF THE CONVERSATION A DECISION HAS SEEN.
 *
 * This is the whole safety mechanism of the paired-thread feature, in one pure
 * function. The failure it exists to prevent, named in the brief that specified
 * the feature: a stale brief producing a confidently wrong verdict. The thinking
 * thread moves on — someone changes their mind at 4pm — the decision brief
 * doesn't, the builder works from it, and something later reports that the work
 * did what was decided.
 *
 * The rule is deliberately blunt: ANY message in the thinking thread newer than
 * the evidence the brief was made from makes it stale. Not "any substantive
 * message", not "any message from the owner" — judging which messages changed
 * the decision is exactly the judgement that gets this wrong, and the cost of
 * being blunt is a re-extraction nobody needed.
 */

export type Freshness = {
  state: 'current' | 'stale';
  /** How many messages the thinking thread has gained since the brief was made. */
  behind: number;
  /** The plain sentence every surface shows. */
  note: string;
};

export type ThinkingMessage = { at: Date; role: string };

export function freshnessOf(
  brief: { evidenceThrough: Date | null; evidenceMessages: number },
  thinking: ThinkingMessage[],
): Freshness {
  // A brief made from nothing is behind everything: with no evidence recorded
  // there is no basis for calling it current.
  const through = brief.evidenceThrough?.getTime() ?? 0;
  const newer = thinking.filter((m) => m.at.getTime() > through).length;

  if (newer === 0) {
    return { state: 'current', behind: 0, note: 'This is written from the whole conversation as it stands.' };
  }
  return {
    state: 'stale',
    behind: newer,
    note:
      newer === 1
        ? 'One thing has been said in the thinking since this was written — it may no longer be what you decided.'
        : `${newer} things have been said in the thinking since this was written — it may no longer be what you decided.`,
  };
}

/** What a builder is told when it is started from a brief that has fallen behind. */
export function staleWarningFor(freshness: Freshness): string {
  return [
    `NOTE: the decision below was written before the last ${freshness.behind} message${freshness.behind === 1 ? '' : 's'} of the conversation it came from.`,
    'Treat it as a draft, not a settled decision: if what you are asked to do contradicts it, say so rather than following it.',
  ].join(' ');
}
