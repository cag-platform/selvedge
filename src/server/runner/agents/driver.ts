import type { AgentId } from '../../../shared/agents.js';
import type { ToolEvent } from '../../../shared/types/toolEvent.js';
import { claudeCommand, parseAssistantText, parseResult, parseToolEvents } from '../daytona/agentCommand.js';
import { codexCommand, codexInstallCommand, codexModel, parseCodexEvents, parseCodexResult, parseCodexText } from '../daytona/codexCommand.js';
import { costUsd } from '../../llm/pricing.js';

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

const claudeDriver: AgentDriver = {
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

function codexDriver(apiKey: string): AgentDriver {
  return {
    id: 'codex',
    setupCommand: codexInstallCommand(),
    command: (prompt, opts) =>
      codexCommand(prompt, {
        apiKey,
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
 * The driver for an agent, or null when it can't run here — Codex without an
 * OpenAI key is not a broken build, it is an agent this deployment hasn't been
 * given the fuel for, and the caller says exactly that.
 */
export function driverFor(agent: AgentId, cfg: { openaiApiKey?: string | null } = {}): AgentDriver | null {
  if (agent === 'claude-code') return claudeDriver;
  if (agent === 'codex') {
    const key = cfg.openaiApiKey?.trim();
    return key ? codexDriver(key) : null;
  }
  // Grok Build is declared in the registry and has no driver yet: the CLI's
  // invocation and event stream are unknown, and three parsers written against
  // a format nobody has seen would produce a turn that reports success it
  // cannot see. Adding it is a file beside codexCommand.ts and a case here.
  //
  // Chat agents don't run in a sandbox at all — chat/turn.ts is their path.
  return null;
}
