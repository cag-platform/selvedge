import type { LedgerEntry } from './entries.js';

/**
 * "I've seen this before" (BUILD-BRIEF Phase 5: memory surfaced in the brief).
 * When a new incident matches one the ledger already holds, the owner shouldn't
 * be told about it as if for the first time — the whole point of the remembered
 * app is that the second occurrence carries the first's lesson.
 *
 * Matching is deliberately conservative: same project, same trigger, same intent
 * (an incident's intent is derived from what broke, so identical intents mean the
 * same kind of problem). A loose match that surfaced the wrong prior would be
 * worse than none — it would put a confident, wrong memory in front of the owner.
 */

/** The most recent prior entry that did real work and matches this intent, or null. */
export function priorOccurrence(entries: LedgerEntry[], match: { intent: string; trigger: LedgerEntry['trigger'] }): LedgerEntry | null {
  // entries arrive newest-first from the store; the first match is the latest.
  return (
    entries.find((e) => e.didWork && e.trigger === match.trigger && e.intent === match.intent) ?? null
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * A plain memory line for the owner, honest about how it went last time. A clean
 * prior outcome is reassuring; a messy one is a warning — both are told straight,
 * because the value of the memory is in the hard cases, not the easy ones.
 */
export function recallNote(prior: LedgerEntry): string {
  const cost = money(prior.spentCents);
  if (prior.verdict === 'verified' || prior.verdict === 'probably') {
    return `I've seen this one before — last time I sorted it for about ${cost}.`;
  }
  if (prior.outcome === 'stopped') {
    return `I've seen this one before — last time we stopped partway (about ${cost} in). Worth deciding up front how far to take it.`;
  }
  // didnt_work / failed
  return `I've seen this one before, and last time it was tricky — it didn't come out clean (about ${cost} spent). I'll be careful with it.`;
}
