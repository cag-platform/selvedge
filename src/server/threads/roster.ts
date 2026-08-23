import type { Db } from '../db/client.js';
import { AGENTS, type AgentId } from '../../shared/agents.js';
import { engineEnv, type EngineEnv } from '../build/engineConfig.js';
import { builderAvailability } from '../build/builderAuth.js';
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
 * A builder needs somewhere to run — the sandbox host, which is the
 * deployment's — AND an account to run on, which is the org's. A talker needs a
 * connected key for its own provider. Every "no" here has a sentence attached,
 * because a greyed-out row with no explanation is the thing that makes people
 * think a product is broken.
 *
 * BOTH BUILDERS ARE ASKED THE SAME QUESTION, by the same resolver the turn
 * itself uses (build/builderAuth.ts). That mattered for Codex first — this row
 * used to read the deployment's environment, so it could say "no OpenAI key" to
 * an owner looking at their own connected OpenAI key on the next screen — and
 * it matters for Claude Code now, whose token came free with the deployment
 * until it didn't. A picker whose availability logic is a second opinion is a
 * picker that eventually disagrees with the thing it is describing.
 */
async function availability(
  db: Db,
  orgId: string,
  agent: (typeof AGENTS)[number],
  env: EngineEnv | null,
  hasProject: boolean,
  builderCan: (agentId: AgentId) => Promise<{ available: boolean; note: string | null }>,
): Promise<{ available: boolean; note: string | null }> {
  // DECLARED IS NOT LIVE, and this is checked FIRST because it outranks every
  // other reason. The registry can name an agent before it is wired, so the
  // picker can be honest about what is coming without offering a row that
  // fails the moment somebody picks it.
  //
  // It sat inside the talker branch when it arrived, which was fine while
  // every builder was live and became wrong the moment one wasn't: a
  // declared-but-unwired builder would have reported itself available on the
  // strength of the engine being switched on.
  if (!agent.live) {
    return { available: false, note: `${agent.name} isn't wired up here yet — it's named so you know it's coming, not offered.` };
  }

  if (agent.changesFiles) {
    // No machine to run on is the deployment's problem and outranks whose
    // account would have paid: there is nothing an owner can connect that fixes
    // it, so offering them a credential to add would be the wrong advice.
    if (!env) {
      return { available: false, note: "The build engine isn't switched on for this deployment — the watching and your brief are unaffected." };
    }
    /**
     * A BUILDER NEEDS SOMEWHERE TO PUT THE CODE, and this row used to forget.
     *
     * In a conversation with no project — an idea, an imported chat, anything
     * under a subject — this said AVAILABLE, switching to it was quoted at
     * nothing, and then the first message came back 409 "there's nothing here
     * to build in". Three surfaces disagreeing about the same question, and the
     * only one that told the truth was the last one, after the switch.
     *
     * It is still LISTED, because hiding it teaches people the product is
     * smaller than it is — and the note says the thing that fixes it, which is
     * a real move rather than a credential to go and find.
     */
    if (!hasProject) {
      return {
        available: false,
        note: `${agent.name} builds inside a project. Give this conversation one — an existing project or a new one — and it can pick this up.`,
      };
    }
    return builderCan(agent.id);
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
  canBuild: (db: Db, orgId: string, agent: AgentId) => Promise<{ available: boolean; note: string | null }> = builderAvailability,
): Promise<AgentOffer[]> {
  const engine = env();
  const from = thread.agent as AgentId;
  // Asked once per builder, and only if something asks. Each answer is cached
  // because two agents can share a provider, and the roster is rendered on
  // every thread open.
  const pending = new Map<AgentId, Promise<{ available: boolean; note: string | null }>>();
  const builderCan = (id: AgentId) => {
    let p = pending.get(id);
    if (!p) {
      p = canBuild(db, orgId, id).catch(() => ({ available: false, note: null }));
      pending.set(id, p);
    }
    return p;
  };

  return Promise.all(
    AGENTS.map(async (agent): Promise<AgentOffer> => {
      const answeringNow = agent.id === from;
      const { available, note } = await availability(db, orgId, agent, engine, Boolean(thread.projectId), builderCan);

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
