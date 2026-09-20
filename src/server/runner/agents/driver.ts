import type { AgentId } from '../../../shared/agents.js';
import type { ToolEvent } from '../../../shared/types/toolEvent.js';
import { claudeCommand, claudeInstallCommand, parseAssistantText, parseResult, parseToolEvents } from '../workers/claudeCommand.js';
import { codexCommand, codexInstallCommand, codexModel, parseCodexEvents, parseCodexResult, parseCodexText } from '../workers/codexCommand.js';
import { costUsd } from '../../llm/pricing.js';
import type { BuilderAuth } from '../../build/builderAuth.js';
import { compatibleCodeCommand, compatibleInstallCommand, parseCompatible, type CompatibleWorker } from '../workers/compatibleCodeCommand.js';
import { geminiCommand, geminiInstallCommand, geminiModel, parseGeminiEvents, parseGeminiResult, parseGeminiText } from '../workers/geminiCommand.js';

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

function claudeDriver(): AgentDriver {
  return {
    id: 'claude-code',
    setupCommand: claudeInstallCommand(),
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

function codexDriver(): AgentDriver {
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

function compatibleDriver(id: CompatibleWorker): AgentDriver {
  return {
    id,
    setupCommand: compatibleInstallCommand(id),
    command: (prompt, opts) => compatibleCodeCommand(id, prompt, opts),
    result: (log) => ({ sessionId: parseCompatible(log).sessionId, isError: false, costUsd: 0, costReported: false }),
    text: (log) => parseCompatible(log).text,
    events: (log) => { const parsed = parseCompatible(log); return { tools: parsed.tools, truncated: parsed.truncated }; },
  };
}

function deepSeekDriver(): AgentDriver {
  const base = claudeDriver();
  return {
    ...base,
    id: 'deepseek-build',
    command: (prompt, opts) => claudeCommand(prompt, opts.model ?? 'deepseek-chat', opts.resumeSessionId, opts.mode),
  };
}

function geminiDriver(): AgentDriver {
  return {
    id: 'gemini-build',
    setupCommand: geminiInstallCommand(),
    // Stateless on purpose: headless Gemini doesn't reliably hand back a
    // session id yet (see the worker's header), so resumeSessionId is unused
    // and every turn carries its own context.
    command: (prompt, opts) => geminiCommand(prompt, { model: opts.model ?? geminiModel(), mode: opts.mode }),
    result: (log) => {
      const parsed = parseGeminiResult(log);
      return {
        sessionId: parsed.sessionId,
        isError: parsed.isError,
        // Tokens, not dollars, same as Codex: priced at the model's published
        // rate, and an unpriced model prices at the table's fallback — the
        // overstating direction, which is the safe one.
        costUsd: parsed.usageReported ? costUsd(geminiModel(), parsed.tokensIn, parsed.tokensOut) : 0,
        costReported: parsed.usageReported,
      };
    },
    text: parseGeminiText,
    events: parseGeminiEvents,
  };
}

/**
 * A CODING-PLAN builder: the Claude Code CLI as the harness, pointed at a
 * provider's Anthropic-compatible endpoint by builderAuth's command env, on a
 * key whose plan is FLAT-MONTHLY. That last fact is why the cost is overridden
 * rather than inherited: the CLI computes dollars from Anthropic's price list,
 * which is a number nobody is being charged. Zero, reported, is the truth —
 * the plan's quota is spent, the ledger's dollars are not.
 */
function codingPlanDriver(id: 'glm-build' | 'kimi-code', model: string): AgentDriver {
  const base = claudeDriver();
  return {
    ...base,
    id,
    command: (prompt, opts) => claudeCommand(prompt, opts.model ?? model, opts.resumeSessionId, opts.mode),
    result: (log) => ({ ...base.result(log), costUsd: 0, costReported: true }),
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
  if (agent === 'claude-code' && auth.agent === 'claude-code') return claudeDriver();
  if (agent === 'codex' && auth.agent === 'codex') return codexDriver();
  // Kimi's KIND picks the harness: a membership key only answers on their
  // Anthropic-compatible coding endpoint (Claude CLI as the harness), a
  // metered Moonshot key drives the native Kimi CLI. builderAuth resolved the
  // kind and set the matching environment; this must agree with it.
  if (agent === 'kimi-code' && auth.agent === 'kimi-code') {
    return auth.kind === 'subscription' ? codingPlanDriver('kimi-code', 'kimi-for-coding') : compatibleDriver('kimi-code');
  }
  if (agent === 'grok-build' && auth.agent === 'grok-build') return compatibleDriver('grok-build');
  if (agent === 'deepseek-build' && auth.agent === 'deepseek-build') return deepSeekDriver();
  if (agent === 'glm-build' && auth.agent === 'glm-build') return codingPlanDriver('glm-build', 'glm-5.3');
  if (agent === 'gemini-build' && auth.agent === 'gemini-build') return geminiDriver();
  // Chat agents don't run in a sandbox at all — chat/turn.ts is their path.
  return null;
}
