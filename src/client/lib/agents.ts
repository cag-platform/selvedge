import { builderNearMiss, mentionedAgents, MAX_CONSULTED } from '../../shared/mentions.js';
import type { AgentId } from '../../shared/agents.js';

/**
 * THE ROSTER, CLIENT-SIDE — the wire shape of `/api/threads/:id/agents`, and
 * the pure rules the composer needs around it.
 *
 * Everything here is a function of text and a roster, so the two things that
 * are easy to get subtly wrong — which `@word` the caret is inside, and what
 * a send is about to cost — are testable without a browser.
 */

export type AgentOffer = {
  id: AgentId;
  name: string;
  chip: string;
  changes_files: boolean;
  does: string;
  cost_note: string;
  answering_now: boolean;
  available: boolean;
  unavailable_note: string | null;
  /** What kind of no: 'org' hides the row from the menu, 'thread' keeps it. */
  blocked_by: 'org' | 'thread' | null;
  handoff: { tokens: number; cost_usd: number | null; note: string } | null;
  models: Array<{ id: string; label: string; tier: 'fast' | 'balanced' | 'deep'; note: string }>;
  selected_model: string;
  readiness?: { state: 'available' | 'unavailable' | 'unknown'; checked_at: string | null; code: string | null; note: string | null };
};

export type RosterResponse = { answering: string; agents: AgentOffer[] };

/**
 * The `@name` the caret is currently inside, or null.
 *
 * Only ever the token being typed at the END of what has been written — a
 * menu that reopened over a name finished three sentences ago would fight the
 * person typing. An empty string is a real answer: `@` alone means "show me
 * everyone", which is how the picker gets discovered by someone who has never
 * typed a mention.
 */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]*)$/.exec(text);
  return match ? (match[1] ?? '') : null;
}

/**
 * The roster narrowed to what is being typed, in registry order — and to what
 * can actually answer. An org-blocked row (no key connected, engine off) is
 * hidden rather than shown orange: with eleven agents in the registry, a menu
 * of mostly instructions drowned the real choices. The one exception is
 * whoever is answering now — the current agent losing its key is a fact this
 * conversation needs in view, not something the menu may hide. Typing a hidden
 * name in full still gets the honest note from sendNote; Connections carries
 * the full list with every reason.
 */
export function offersMatching(agents: AgentOffer[], query: string): AgentOffer[] {
  const offerable = agents.filter((a) => a.blocked_by !== 'org' || a.answering_now);
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (q === '') return offerable;
  return offerable.filter((a) => a.id.replace(/[^a-z0-9]/g, '').startsWith(q) || a.name.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(q));
}

/**
 * Replace the half-typed mention at the caret with a whole one. Returns the
 * text with a trailing space, so the sentence carries straight on — picking a
 * name should never cost you a keystroke.
 */
export function completeMention(text: string, agent: AgentId): string {
  return text.replace(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]*)$/, (whole, typed: string) => {
    const lead = whole.slice(0, whole.length - typed.length - 1);
    return `${lead}@${agent} `;
  });
}

/**
 * WHAT PRESSING SEND IS ABOUT TO COST, said before it is pressed.
 *
 * This is the rule the picker used to break: the handover price arrived on the
 * thread AFTER a switch, so committing was how you found out. Every number
 * here comes from the server's own quote, which is the same code that does the
 * charging.
 *
 * Null when there is nothing to say — no mention, or a mention of whoever is
 * already answering, which costs nothing and needs no announcement.
 */
export function sendNote(text: string, agents: AgentOffer[]): string | null {
  // The near-miss outranks everything else this note could say: a message
  // about to route to the wrong agent is the thing to catch before send.
  const miss = builderNearMiss(text);
  if (miss) return miss;
  const named = mentionedAgents(text);
  if (named.length === 0) return null;

  const offers = named.map((id) => agents.find((a) => a.id === id)).filter((a): a is AgentOffer => Boolean(a));
  if (offers.length === 0) return null;

  // One name is a handover, and its price is the thing to say.
  if (offers.length === 1) {
    const only = offers[0]!;
    if (only.answering_now) return null;
    if (!only.available) return only.unavailable_note;
    return only.handoff && only.handoff.tokens > 0 ? `Handing over to ${only.name} — ${only.handoff.note}` : `Handing over to ${only.name} — switching is free`;
  }

  // Several is a consultation: everyone answers, nobody takes it over, and
  // the count is what costs — so the count is what gets said.
  const asked = offers.slice(0, MAX_CONSULTED);
  const dropped = offers.length - asked.length;
  const names = asked.map((a) => a.name);
  const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const tail = dropped > 0 ? ` (${dropped} more named than I'll ask at once)` : '';
  return `Asking ${list} for a take — ${asked.length} turns, and nothing gets built${tail}`;
}

/** Whoever is currently answering, for the chip beside the composer. */
export function answering(agents: AgentOffer[]): AgentOffer | null {
  return agents.find((a) => a.answering_now) ?? null;
}
