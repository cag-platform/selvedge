import type { Card } from '../cards/types.js';
import type { CardAction } from '../cards/machine.js';
import type { ApplyResult } from '../cards/store.js';

/**
 * The agent runner's contract (BUILD-BRIEF Phase 3). The runner does the `work`
 * between approve and verify — provision an isolated sandbox, let the agent make
 * the change, and drive the card through the machine so every safety guarantee
 * still holds while real work happens.
 *
 * Everything that touches the outside world is injected, so the ORCHESTRATION —
 * the part that must obey the cap and the checkpoints — is pure and testable
 * without a sandbox, a model, or a repo. Toile's Daytona lifecycle and agent
 * loop are the injected implementations; they are network code, marked
 * unverified-until-live like the host connectors.
 */

/** A provisioned isolated workspace (Daytona, platform-owned with per-org quotas). */
export type SandboxHandle = { id: string };

export type SandboxProvider = {
  /** Provision a sandbox for a card's project and clone the customer's repo into it. */
  create: (card: Card) => Promise<SandboxHandle>;
  /** Tear the sandbox down. Called in a finally — must tolerate being called after a failure. */
  destroy: (handle: SandboxHandle) => Promise<void>;
};

export type AgentContext = {
  card: Card;
  sandbox: SandboxHandle;
  /** 1-based iteration number, for the agent and for the loop-stall backstop. */
  step: number;
};

/** The result of one agent iteration. */
export type AgentStepResult = {
  /** What this iteration cost, in whole US cents. Drives the cap and checkpoints. */
  spentCents: number;
  /** Whether the change is complete and ready to verify. */
  done: boolean;
  /** A plain line describing what this step did, recorded on the card. */
  note?: string;
};

export type RunnerDeps = {
  /** Drive the card through the machine + persistence (the store's applyAction, bound to org+card). */
  apply: (action: CardAction) => Promise<ApplyResult>;
  sandbox: SandboxProvider;
  /** One agent iteration. Injected — Toile's agent loop in production. */
  agentStep: (ctx: AgentContext) => Promise<AgentStepResult>;
  now: () => Date;
  /** Loop-stall backstop: the most iterations before the runner gives up. */
  maxSteps?: number;
};

/**
 * How a run ended:
 *   ready_to_verify — work complete; the card is now `verifying` (Phase 4 takes over)
 *   stopped         — a spend hit the cap; the card is `stopped`, work halted
 *   checkpoint      — a staged checkpoint paused work; the card is `blocked`, awaiting the owner
 *   failed          — an agent error or a loop-stall; the card is `failed`
 *   not_runnable    — the card wasn't in a state the runner can act on (no work done)
 */
export type RunOutcome = 'ready_to_verify' | 'stopped' | 'checkpoint' | 'failed' | 'not_runnable';

export type RunResult = { outcome: RunOutcome; card: Card };
