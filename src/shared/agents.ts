/**
 * The agent registry — one table, the way `connectors/registry.ts` is one table
 * for providers. Everything that needs to know an agent exists reads it here:
 * the handoff composer (who it is writing for), the thread store (what an
 * agent id may be), and the composer's switcher.
 *
 * THREE RULES, all load-bearing.
 *
 * 1. IDENTITY IS TEXT, NEVER COLOR OR BRAND. Status color is spoken for —
 *    `--thread` red means "this needs you" and nothing else — so agent identity
 *    gets its own non-color system: a two-to-three character mono mark on a
 *    plain field (DESIGN-NOTES, workbench register §6.5). No logos, no brand
 *    colors, ever, including for agents added later.
 *
 * 2. DECLARED IS NOT LIVE. The seam declares the roadmap; `live` says what can
 *    actually run today. This is the FUEL_PROVIDERS pattern, and it exists so a
 *    surface can be honest about what is coming without offering a picker entry
 *    that fails on first use.
 *
 * 3. CAPABILITY, NOT MODE. An agent is described by what it can DO — whether it
 *    changes files — never by what kind of conversation it is allowed into.
 *    There used to be a `kinds` field here, and a matching `kind` on a thread,
 *    and between them they walled talking off from building: to move a
 *    conversation from deciding what to build to building it, you had to start
 *    a second conversation and say everything twice. That wall was the single
 *    biggest thing standing between this product and its own promise, so it is
 *    gone. Any agent can join any conversation; what differs is what happens
 *    when it answers.
 *
 * Ids are stored in `threads.agent` and read back everywhere, so they may be
 * added but never renamed.
 */

export type AgentId = 'claude-code' | 'codex' | 'claude' | 'gpt';

export type AgentDescriptor = {
  id: AgentId;
  /** The mono mark. Two or three characters; the text carries the identity. */
  chip: string;
  /** What a person calls it. */
  name: string;
  /**
   * Does answering mean editing the project's code? This is the only
   * distinction between agents that has ever mattered, and it decides which
   * path a turn takes — the sandbox, or a plain model call.
   */
  changesFiles: boolean;
  /** Whose fuel it burns — what the ledger attributes the spend to. */
  provider: 'anthropic' | 'openai';
  /**
   * The model id used to PRICE context carried to this agent (a handoff), from
   * config/model-pricing.json. Not necessarily the model it runs: a CLI agent
   * picks its own and reports what the turn really cost, which is what the run
   * row records. This is only for quoting the size of a handover honestly at
   * the moment it happens.
   */
  pricingModel: string;
  /**
   * The one honest line the switcher shows before you pick. Comparative where a
   * number would be a guess: what it costs depends on the turn, and a precise
   * figure we can't stand behind is worse than an honest comparison.
   */
  costNote: string;
  /**
   * Can it run today? This means WIRED, not FUELLED: every agent here has a
   * real path to a real model, and an agent whose key the owner hasn't
   * connected says exactly that when asked, rather than being hidden. Hiding a
   * wired agent teaches people the product is smaller than it is.
   */
  live: boolean;
};

const AGENT_TABLE = {
  'claude-code': {
    id: 'claude-code',
    chip: 'CC',
    name: 'Claude Code',
    changesFiles: true,
    provider: 'anthropic',
    pricingModel: 'claude-sonnet-5',
    costNote: "builds in your project's sandbox — about $0.05–0.30 a turn",
    live: true,
  },
  codex: {
    id: 'codex',
    chip: 'CX',
    name: 'Codex',
    changesFiles: true,
    provider: 'openai',
    pricingModel: 'gpt-5.6-terra',
    costNote: 'builds in the same sandbox, on your OpenAI key — about $0.05–0.30 a turn',
    // The driver is real (runner/agents/driver.ts); without an OpenAI key it
    // returns null and the caller says so. That is fuel, not wiring.
    live: true,
  },
  claude: {
    id: 'claude',
    chip: 'CL',
    name: 'Claude',
    changesFiles: false,
    provider: 'anthropic',
    pricingModel: 'claude-sonnet-5',
    costNote: 'plain chat on your own model key — a fraction of what a build turn costs',
    live: true,
  },
  gpt: {
    id: 'gpt',
    chip: 'GPT',
    name: 'GPT',
    changesFiles: false,
    provider: 'openai',
    pricingModel: 'gpt-5.6-terra',
    costNote: 'plain chat on your own OpenAI key — a fraction of what a build turn costs',
    live: true,
  },
} satisfies Record<AgentId, AgentDescriptor>;

export const AGENTS: readonly AgentDescriptor[] = Object.values(AGENT_TABLE);

export function agentById(id: string): AgentDescriptor | null {
  return (AGENT_TABLE as Record<string, AgentDescriptor>)[id] ?? null;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && value in AGENT_TABLE;
}

/** Does answering as this agent mean touching the project's code? */
export function changesFiles(agent: string): boolean {
  return agentById(agent)?.changesFiles ?? false;
}

/**
 * Every agent a conversation may be handed to. There is no filter any more —
 * that WAS the wall. The picker shows the whole roster and says what each one
 * does, which is the only honest way to offer a choice.
 */
export function switchableAgents(): AgentDescriptor[] {
  return [...AGENTS];
}

/**
 * Where a conversation STARTS. Not where it has to stay — that distinction is
 * the whole point, and it is why this is a default rather than a rule.
 *
 * Someone who pressed "build something" means it, so that thread opens on a
 * builder; everything else opens on a talker, which is both cheaper and the
 * answer that is never wrong when nobody has said yet what they want. Either
 * way the next sentence can hand it to anyone.
 */
export function startingAgentFor(intent: 'workshop' | 'general'): AgentId {
  return intent === 'workshop' ? 'claude-code' : 'claude';
}

/** Where a conversation with no stated intent starts: talking. */
export const DEFAULT_AGENT: AgentId = 'claude';
