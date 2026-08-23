import type { Db } from '../db/client.js';
import { AGENTS, type AgentId } from '../../shared/agents.js';
import { engineEnv, type EngineEnv } from '../build/engineConfig.js';
import { resolveOpenAiKey } from '../build/openaiKey.js';
import { resolveFuelFor } from '../connectors/fuel/resolve.js';
import { quoteHandoff, quoteNote } from './switch.js';
import type { Thread } from './store.js';

/**
 * THE ROSTER — everyone who could answer this conversation, what each would
 * do, and what handing it over would cost, before anything is handed over.
 *
 * Two rules the picker used to break, both fixed here rather than in the view:
 *
 * 1. THE PRICE IS A PRICE TAG, NOT A RECEIPT. The handover cost used to appear
 *    on the thread AFTER a switch, which meant committing in order to find out.
 *    It is quoted here, per candidate, from the same `quoteHandoff` the switch
 *    itself uses — so the number shown cannot drift from the number charged.
 *
 * 2. NOTHING IS HIDDEN, AND NOTHING LIES. Every agent is listed. One that
 *    cannot run right now says exactly why — a key nobody connected, an engine
 *    this deployment hasn't been given — instead of quietly vanishing from the
 *    list, which teaches people the product is smaller than it is.
 */
export type AgentOffer = {
  id: AgentId;
  name: string;
  chip: string;
  /** The one distinction that matters, said plainly. */
  changes_files: boolean;
  /** What it does, in a sentence, for the line under its name. */
  does: string;
  /** What a turn on it tends to cost — comparative, because exact would be a guess. */
  cost_note: string;
  answering_now: boolean;
  /** Could it actually take a turn right now? */
  available: boolean;
  /** Why not, in the owner's words. Null when it can. */
  unavailable_note: string | null;
  /** What switching would cost. Absent for whoever is already answering. */
  handoff: { tokens: number; cost_usd: number | null; note: string } | null;
};

function does(changesFiles: boolean): string {
  return changesFiles ? 'Changes files in your sandbox.' : "Talks it through. Doesn't touch your files.";
}

/**
 * Can this agent take a turn for this org today?
 *
 * A builder needs the build engine, and Codex needs an OpenAI key on top of it
 * — its driver returns null without one, which is fuel rather than wiring. A
 * talker needs a connected key for its own provider. Every "no" here has a
 * sentence attached, because a greyed-out row with no explanation is the thing
 * that makes people think a product is broken.
 *
 * Codex's key is resolved exactly as GPT's is — the org's own connected key
 * first. It used to be read from the deployment's environment alone, which
 * meant this row could say "no OpenAI key" to an owner looking at their own
 * connected OpenAI key on the next screen.
 */
async function availability(
  db: Db,
  orgId: string,
  agent: (typeof AGENTS)[number],
  env: EngineEnv | null,
  openAiKey: () => Promise<string | null>,
): Promise<{ available: boolean; note: string | null }> {
  if (agent.changesFiles) {
    if (!env) {
      return { available: false, note: "The build engine isn't switched on for this deployment — the watching and your brief are unaffected." };
    }
    if (agent.id === 'codex' && !(await openAiKey())) {
      return {
        available: false,
        note: `${agent.name} builds on an OpenAI key. Add one under Connections and it can build here.`,
      };
    }
    return { available: true, note: null };
  }

  // DECLARED IS NOT LIVE. The registry can name an agent before it is wired,
  // so the picker can be honest about what is coming without offering a row
  // that fails the moment somebody picks it.
  if (!agent.live) {
    return { available: false, note: `${agent.name} isn't wired up yet — it's named here so you know it's coming.` };
  }

  const fuel = await resolveFuelFor(db, orgId, agent.provider).catch(() => null);
  if (!fuel) {
    return { available: false, note: `No key connected for ${agent.name}. Add one under Connections and it can answer here.` };
  }
  return { available: true, note: null };
}

export async function agentRoster(
  db: Db,
  orgId: string,
  thread: Thread,
  env: () => EngineEnv | null = engineEnv,
  openAi: (db: Db, orgId: string) => Promise<string | null> = resolveOpenAiKey,
): Promise<AgentOffer[]> {
  const engine = env();
  const from = thread.agent as AgentId;
  // Asked at most once for the whole roster, and only if something asks.
  let pending: Promise<string | null> | null = null;
  const openAiKey = () => (pending ??= openAi(db, orgId).catch(() => null));

  return Promise.all(
    AGENTS.map(async (agent): Promise<AgentOffer> => {
      const answeringNow = agent.id === from;
      const { available, note } = await availability(db, orgId, agent, engine, openAiKey);

      // Nobody quotes you a price for staying where you are.
      const quote = answeringNow ? null : await quoteHandoff(db, orgId, thread, from, agent.id);

      return {
        id: agent.id,
        name: agent.name,
        chip: agent.chip,
        changes_files: agent.changesFiles,
        does: does(agent.changesFiles),
        cost_note: agent.costNote,
        answering_now: answeringNow,
        available,
        unavailable_note: note,
        handoff: quote ? { tokens: quote.tokens, cost_usd: quote.costUsd, note: quoteNote(quote.tokens, quote.costUsd) } : null,
      };
    }),
  );
}
