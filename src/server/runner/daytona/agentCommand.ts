import type { Card } from '../../cards/types.js';
import type { AgentStepResult } from '../types.js';

/**
 * The pure parts of the agent step — everything that can be decided without a
 * sandbox: the prompt handed to the Claude Code CLI, the shell command that runs
 * it, parsing the CLI's stream-json output for the final result, and mapping that
 * result to the runner's AgentStepResult (cost in cents, done, note). Ported from
 * Toile's proven runner; the network parts live in provider.ts.
 */

/** The sandbox working directory (matches the Toile clone target). */
export const WORKDIR = '/workspace/app';
const PATH_PREFIX = 'export PATH="$HOME/.npm-global/bin:$PATH" &&';

/** Shell-single-quote a value safely (Toile's shellQuote). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The instruction the agent works from. It is the owner's ask, framed so the
 * agent edits the repo in place and keeps the change focused — no ceremony, no
 * deploy (Selvedge ships separately, after verification).
 */
export function buildAgentPrompt(card: Card): string {
  const ask = card.trigger === 'request' ? card.title : `${card.title}. ${card.proposal}`;
  return [
    `You are making one focused change to a live application, in this repository.`,
    `The owner asked: "${ask}".`,
    `Make just that change, cleanly and minimally. Do not start a dev server or deploy —`,
    `only edit the code. When you are done, make sure the project still builds if it has a build step.`,
  ].join(' ');
}

/**
 * The remote command: run one Claude Code turn to completion, streaming
 * stream-json so we can read the final cost and success. `--dangerously-skip-
 * permissions` is safe here because the whole thing runs inside a throwaway
 * sandbox that holds only this one app's code.
 */
export function claudeCommand(prompt: string, model = 'sonnet'): string {
  const args = [
    'claude',
    '-p',
    shellQuote(prompt),
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model',
    model,
  ];
  return `${PATH_PREFIX} cd ${WORKDIR} && ${args.join(' ')}`;
}

export type ResultEvent = {
  subtype: string;
  totalCostUsd: number | null;
  isError: boolean;
};

/**
 * Extract the final `result` event from the CLI's stream-json stdout. The output
 * is newline-delimited JSON; the last `type: "result"` line carries the cost and
 * the success flag. Returns null when no result line is present (a crashed or
 * killed run) — the caller treats that as "no confirmed work", never a success.
 */
export function parseResult(stdout: string): ResultEvent | null {
  let found: ResultEvent | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'result') {
      found = {
        subtype: typeof event.subtype === 'string' ? event.subtype : 'unknown',
        totalCostUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        isError: event.is_error === true || event.subtype !== 'success',
      };
    }
  }
  return found;
}

/**
 * Map a finished Claude turn to the runner's step result. One turn is the whole
 * change, so `done` is always true — the runner then hands off to verification,
 * which is where an incomplete or wrong change is caught. The cost is real
 * spend and drives the cap and checkpoints. A missing or errored result records
 * whatever cost was reported (often none) and lets verification judge the rest.
 */
export function resultToStep(result: ResultEvent | null): AgentStepResult {
  const spentCents = Math.max(0, Math.round((result?.totalCostUsd ?? 0) * 100));
  if (!result) {
    return { spentCents, done: true, note: 'the agent did not return a result — verification will judge what, if anything, changed' };
  }
  return {
    spentCents,
    done: true,
    note: result.isError ? `the agent reported a problem (${result.subtype})` : 'made the change',
  };
}
