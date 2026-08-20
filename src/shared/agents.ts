import type { ThreadKind } from './types/thread.js';

/**
 * The agent registry — one table, the way `connectors/registry.ts` is one table
 * for providers. Everything that needs to know an agent exists reads it here:
 * the handoff composer (who it is writing for), the thread store (what an
 * agent id may be), and, from Phase 1, the composer's switcher.
 *
 * TWO RULES, both load-bearing.
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
 * Ids are stored in `threads.agent` and read back by every later phase, so they
 * may be added but never renamed.
 */

export type AgentId = 'claude-code' | 'codex' | 'claude' | 'gpt';

export type AgentDescriptor = {
  id: AgentId;
  /** The mono mark. Two or three characters; the text carries the identity. */
  chip: string;
  /** What a person calls it. */
  name: string;
  /** Which kinds of thread this agent can run. A builder needs a sandbox; a chat model doesn't. */
  kinds: readonly ThreadKind[];
  /** Whose fuel it burns — what the ledger attributes the spend to. */
  provider: 'anthropic' | 'openai';
  /**
   * The one honest line the switcher shows before you pick. Comparative where a
   * number would be a guess: what it costs depends on the turn, and a precise
   * figure we can't stand behind is worse than an honest comparison.
   */
  costNote: string;
  /** Can it run today? Declared-but-not-live agents are roadmap, not offers. */
  live: boolean;
};

const AGENT_TABLE = {
  'claude-code': {
    id: 'claude-code',
    chip: 'CC',
    name: 'Claude Code',
    kinds: ['workshop'],
    provider: 'anthropic',
    costNote: "builds in your project's sandbox — about $0.05–0.30 a turn",
    live: true,
  },
  codex: {
    id: 'codex',
    chip: 'CX',
    name: 'Codex',
    kinds: ['workshop'],
    provider: 'openai',
    costNote: 'builds in the same sandbox, on your OpenAI key — about $0.05–0.30 a turn',
    live: false,
  },
  claude: {
    id: 'claude',
    chip: 'CL',
    name: 'Claude',
    kinds: ['general'],
    provider: 'anthropic',
    costNote: 'plain chat on your own model key — a fraction of what a build turn costs',
    live: false,
  },
  gpt: {
    id: 'gpt',
    chip: 'GPT',
    name: 'GPT',
    kinds: ['general'],
    provider: 'openai',
    costNote: 'plain chat on your own OpenAI key — a fraction of what a build turn costs',
    live: false,
  },
} satisfies Record<AgentId, AgentDescriptor>;

export const AGENTS: readonly AgentDescriptor[] = Object.values(AGENT_TABLE);

export function agentById(id: string): AgentDescriptor | null {
  return (AGENT_TABLE as Record<string, AgentDescriptor>)[id] ?? null;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && value in AGENT_TABLE;
}

/** Every agent that could run this kind of thread, live or not (the roadmap surface). */
export function agentsFor(kind: ThreadKind): AgentDescriptor[] {
  return AGENTS.filter((a) => a.kinds.includes(kind));
}

/** Only the ones that actually work today — what a picker may offer. */
export function liveAgentsFor(kind: ThreadKind): AgentDescriptor[] {
  return agentsFor(kind).filter((a) => a.live);
}

/** What a new thread of this kind starts with. */
export function defaultAgentFor(kind: ThreadKind): AgentId {
  return kind === 'workshop' ? 'claude-code' : 'claude';
}
