import type { AgentId } from '../../../shared/agents.js';
import type { ToolEvent } from '../../../shared/types/toolEvent.js';
import { claudeCommand, parseAssistantText, parseResult, parseToolEvents } from '../workers/claudeCommand.js';
import { codexCommand, codexInstallCommand, codexModel, parseCodexEvents, parseCodexResult, parseCodexText } from '../workers/codexCommand.js';
import { costUsd } from '../../llm/pricing.js';
import type { BuilderAuth } from '../../build/builderAuth.js';

/**
 * ONE SHAPE FOR "A BUILDER". The workshop turn (build/agent.ts) is a long,
 * carefully-tuned orchestration — start detached, poll the log, stream the
 * activity, retry a stale session, record the flight record, price the turn.
 * None of that is Claude-specific, and it must not be duplicated per agent: two
 * copies of that loop would drift, and the one that drifts is the one nobody
 * dogfoods.
 *
 * So the agent-specific parts are exactly four — the command that runs a turn,
 * and the three parsers that read its output — and they live behind this seam.
 * Adding a third builder is a file next to codexCommand.ts and a case here.
 *
 * EVERY BUILDER IS BUILT FROM A CREDENTIAL NOW. Claude Code used to be a
 * constant here, because its token came from the deployment's environment and
 * was already inside the sandbox before this seam was reached. Codex took one.
 * That asymmetry WAS the bug — see build/builderAuth.ts — so the shape is the
 * same for both: no credential, no driver, and the caller says so by name.
 */

export type TurnResult = {
  /** The CLI's session, saved so the next turn continues the conversation. */
  sessionId: string | null;
  isError: boolean;
  costUsd: number;
  /**
   * Did the agent actually report what the turn used? False means the cost is
   * UNKNOWN — the caller says so rather than showing a confident zero. "Never a
   * surprise bill" is broken by an undercount just as surely as an overcharge.
   */
  costReported: boolean;
};

export type AgentDriver = {
  id: AgentId;
  /** Run before the turn if the sandbox might not have this CLI yet; null when the image ships it. */
  setupCommand: string | null;
  command(prompt: string, opts: { model?: string | null; resumeSessionId?: string | null; mode: 'build' | 'plan' }): string;
  result(log: string): TurnResult;
  text(log: string): string;
  events(log: string): { tools: ToolEvent[]; truncated: boolean };
};

function claudeDriver(auth: BuilderAuth): AgentDriver {
  return {
    id: 'claude-code',
    // The Daytona base image ships the Claude Code CLI, and sandbox.ts installs
    // it if a future image doesn't.
    setupCommand: null,
    command: (prompt, opts) => claudeCommand(prompt, opts.model ?? 'sonnet', opts.resumeSessionId, opts.mode),
    result: (log) => {
      const parsed = parseResult(log);
      return {
        sessionId: parsed?.sessionId ?? null,
        isError: parsed === null || parsed.isError,
        costUsd: parsed?.totalCostUsd ?? 0,
        costReported: typeof parsed?.totalCostUsd === 'number',
      };
    },
    text: parseAssistantText,
    events: parseToolEvents,
  };
}

function codexDriver(auth: BuilderAuth): AgentDriver {
  return {
    id: 'codex',
    setupCommand: codexInstallCommand(),
    command: (prompt, opts) =>
      codexCommand(prompt, {
        model: opts.model ?? codexModel(),
        resumeSessionId: opts.resumeSessionId ?? null,
        mode: opts.mode,
      }),
    result: (log) => {
      const parsed = parseCodexResult(log);
      return {
        sessionId: parsed.sessionId,
        isError: parsed.isError,
        // Codex reports tokens, not dollars, so the turn is priced at the
        // model's published rate. An unpriced model prices at the table's
        // fallback, which overstates — the safe direction for spend.
        costUsd: parsed.usageReported ? costUsd(codexModel(), parsed.tokensIn, parsed.tokensOut) : 0,
        costReported: parsed.usageReported,
      };
    },
    text: parseCodexText,
    events: parseCodexEvents,
  };
}

/**
 * The driver for an agent, or null when it can't run — which now means exactly
 * one thing for every builder: nobody has given it an account to run on. The
 * caller has the resolver's own sentence for that and says it, rather than
 * inventing a generic one.
 */
export function driverFor(agent: AgentId, auth: BuilderAuth | null): AgentDriver | null {
  if (!auth) return null;
  if (agent === 'claude-code' && auth.agent === 'claude-code') return claudeDriver(auth);
  if (agent === 'codex' && auth.agent === 'codex') return codexDriver(auth);
  // Chat agents don't run in a sandbox at all — chat/turn.ts is their path.
  return null;
}
