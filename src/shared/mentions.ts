import { AGENTS, type AgentId } from './agents.js';

/**
 * @-MENTIONS — choosing who answers, in the sentence where the intent already
 * is.
 *
 * "@claudecode ok build it" is one thought, not a menu selection followed by a
 * sentence. So the composer parses names out of what was typed, and the text
 * itself is left completely alone: it is the record, and a person wrote it.
 *
 * TWO SHAPES, and the difference between them is not decoration.
 *
 *   One name  — direction. This turn is answered by that agent, and because
 *               that is a switch, it is priced and recorded like any other.
 *   Two+ names — a CONSULTATION. Everyone named answers the same question, and
 *               the conversation does not change hands: asking two people what
 *               they think is not handing the work to either of them.
 *
 * THE PARSE IS THE SERVER'S. The client parses too — it has to, to quote the
 * price before you press send — but what actually happens is decided here,
 * from the stored text, because that is the only version nobody can lie about.
 */

/** An agent's name as it may be typed: no punctuation, no case. */
function normalise(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The lookup, built once from the registry. Matching is EXACT on the
 * normalised form, never by prefix — `@claude` and `@claudecode` are two
 * different agents, and a prefix match would silently route one to the other.
 */
const BY_NAME: ReadonlyMap<string, AgentId> = new Map(AGENTS.map((a) => [normalise(a.id), a.id]));

/**
 * A mention starts a word. Without that rule an email address donates its
 * domain to whoever is listening, and a pasted stylesheet's `@media` becomes a
 * request.
 */
const MENTION = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_-]+)/g;

/**
 * Every agent named in this message, in the order they were named, without
 * repeats.
 *
 * A name nobody recognises is IGNORED rather than guessed at or rejected: the
 * text is prose that happens to contain an `@`, and refusing to send a message
 * because of one would be absurd.
 */
export function mentionedAgents(text: string): AgentId[] {
  const found: AgentId[] = [];
  for (const match of text.matchAll(MENTION)) {
    const agent = BY_NAME.get(normalise(match[2] ?? ''));
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/** What the mentions in a message ask for. */
export type MentionIntent =
  /** Nobody named — whoever answered last carries on. Continuity is the default. */
  | { kind: 'continue' }
  /** One named — this turn is theirs, and the conversation changes hands. */
  | { kind: 'direct'; agent: AgentId }
  /** Several named — everyone answers, and the conversation stays where it is. */
  | { kind: 'consult'; agents: AgentId[] };

export function mentionIntent(text: string): MentionIntent {
  const agents = mentionedAgents(text);
  if (agents.length === 0) return { kind: 'continue' };
  if (agents.length === 1) return { kind: 'direct', agent: agents[0]! };
  return { kind: 'consult', agents };
}

/**
 * How many agents may be consulted at once.
 *
 * Not a technical limit — a spend one. Every name on the line is another turn
 * on the owner's own key, and a message that quietly fanned out to six of them
 * would be exactly the kind of surprise this product exists to not produce.
 */
export const MAX_CONSULTED = 3;

/**
 * The line a consultation writes into the conversation before the answers
 * arrive, so what was asked of whom is on the record — and so the one thing
 * people will reasonably assume is stated instead: nobody's files were
 * touched. A consultation asks for opinions. It is not several agents building
 * at once, which the sandbox could not do anyway.
 */
export function consultationLine(agents: AgentId[], names: (id: AgentId) => string): string {
  const said = agents.map(names);
  const list = said.length === 2 ? said.join(' and ') : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
  return `⇄ asked ${list} for a take — nothing was built, and the conversation stays where it is.`;
}
