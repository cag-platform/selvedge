import type { Card } from '../cards/types.js';
import type { CardAction } from '../cards/machine.js';
import type { ApplyResult } from '../cards/store.js';
import type { ToolEvent } from '../../shared/types/toolEvent.js';
import type { WorkspaceHandle } from '../workspace/types.js';

/**
 * The agent runner's contract (BUILD-BRIEF Phase 3). The runner does the `work`
 * between approve and verify — provision an isolated workspace, let the agent make
 * the change, and drive the card through the machine so every safety guarantee
 * still holds while real work happens.
 *
 * Everything that touches the outside world is injected, so the ORCHESTRATION —
 * the part that must obey the cap and the checkpoints — is pure and testable
 * without a workspace, a model, or a repo. Temporary legacy wiring supplies
 * the current implementation while Selvedge's native runtime replaces it.
 */

/**
 * The small part of the Selvedge Workspace Runtime needed by the governed card
 * loop. The full runtime contract lives in workspace/types.ts; this adapter
 * keeps card policy independent of repository and provider setup details.
 */
export type CardWorkspaceRuntime = {
  createWorkspace: (card: Card) => Promise<WorkspaceHandle>;
  destroyWorkspace: (handle: WorkspaceHandle) => Promise<void>;
};

export type AgentContext = {
  card: Card;
  workspace: WorkspaceHandle;
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
  /** The step's structured tool record (flight recorder) — rides the spend act's meta. */
  tools?: ToolEvent[];
};

export type RunnerDeps = {
  /** Drive the card through the machine + persistence (the store's applyAction, bound to org+card). */
  apply: (action: CardAction) => Promise<ApplyResult>;
  workspaceRuntime: CardWorkspaceRuntime;
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
