import type { Db } from '../db/client.js';
import { getCard, applyAction } from '../cards/store.js';
import { runCard } from './run.js';
import type { RunResult, CardWorkspaceRuntime, AgentContext, AgentStepResult } from './types.js';

/**
 * The persistence bridge for the runner: it binds the pure orchestration to a
 * real card in the database. `apply` becomes the store's applyAction — so every
 * state move the runner makes goes through the same machine-and-persist path the
 * owner's API uses, and the cap-and-gate guarantees hold identically.
 *
 * The workspace and agent step stay injected. They are the live pieces —
 * temporary Development Workspaces and the worker loop — which are network code
 * that can't be verified here, so they're supplied by the caller (a future
 * approve→run wiring) rather than hardcoded. Everything the runner does WITH
 * them is already proven.
 */
export type RunCardDeps = {
  workspaceRuntime: CardWorkspaceRuntime;
  agentStep: (ctx: AgentContext) => Promise<AgentStepResult>;
  now?: () => Date;
  maxSteps?: number;
};

export type RunCardOutcome = RunResult | { outcome: 'not_found'; card: null };

/** Load a card and run it. Returns not_found when the card isn't this org's. */
export async function runCardForOrg(db: Db, orgId: string, cardId: string, deps: RunCardDeps): Promise<RunCardOutcome> {
  const card = await getCard(db, orgId, cardId);
  if (!card) return { outcome: 'not_found', card: null };

  return runCard(
    {
      apply: (action) => applyAction(db, orgId, cardId, action),
      workspaceRuntime: deps.workspaceRuntime,
      agentStep: deps.agentStep,
      now: deps.now ?? (() => new Date()),
      maxSteps: deps.maxSteps,
    },
    card,
  );
}
