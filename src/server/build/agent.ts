import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, type SandboxConfig } from './sandbox.js';
import { claudeCommand, parseResult, parseAssistantText } from '../runner/daytona/agentCommand.js';

/**
 * One workshop turn: the owner says what they want in plain English, the agent
 * does it in the project's persistent sandbox, and the conversation continues
 * across turns (--resume), so iteration is "now make it darker", not starting
 * over. Every turn's real cost is recorded in cents on its run row — the
 * founder's cost-watch rule applied to the agent as well as the sandbox.
 *
 * The command execution is injectable so the whole orchestration is testable
 * without Daytona; the default executor runs in the real sandbox. A stale
 * --resume (the session file died with a recreated sandbox) is retried once
 * fresh rather than failing the turn.
 */

export type ExecuteInSandbox = (command: string, timeoutSec: number) => Promise<{ exitCode: number; result?: string }>;

export type AgentTurnConfig = SandboxConfig & { model?: string };

export type AgentTurnOutcome = {
  runId: string;
  status: 'succeeded' | 'failed';
  costCents: number;
  /** The agent's reply for the chat thread. */
  reply: string;
  /** Whether the sandbox now holds changes ready to ship. */
  stagedChangesReady: boolean;
};

const TURN_TIMEOUT_SEC = 1800;

export async function runAgentTurn(
  db: Db,
  orgId: string,
  projectId: string,
  ownerText: string,
  cfg: AgentTurnConfig,
  deps: { execute?: ExecuteInSandbox } = {},
): Promise<AgentTurnOutcome> {
  // The owner's message lands on the thread first — the conversation is the record.
  await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, role: 'owner', content: ownerText });

  const runId = ulid();
  const model = cfg.model ?? 'sonnet';
  await db.insert(agentRuns).values({ id: runId, orgId, projectId, prompt: ownerText, model, status: 'running', startedAt: new Date() });

  const execute: ExecuteInSandbox =
    deps.execute ??
    (await (async () => {
      const sandbox = await ensureSandbox(db, orgId, projectId, cfg);
      return (command: string, timeoutSec: number) => sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
    })());

  const prior = await getBuild(db, orgId, projectId);
  let res = await execute(claudeCommand(ownerText, model, prior?.claudeSessionId), TURN_TIMEOUT_SEC);

  // A stale session (sandbox was recreated; the session file died with it)
  // fails the resume. Retry once fresh instead of failing the owner's turn.
  if (res.exitCode !== 0 && prior?.claudeSessionId) {
    await setBuild(db, orgId, projectId, { claudeSessionId: null });
    res = await execute(claudeCommand(ownerText, model, null), TURN_TIMEOUT_SEC);
  }

  const stdout = res.result ?? '';
  const result = parseResult(stdout);
  const narrative = parseAssistantText(stdout);
  const succeeded = res.exitCode === 0 && result !== null && !result.isError;
  const costCents = Math.max(0, Math.round((result?.totalCostUsd ?? 0) * 100));

  // Does the sandbox now hold uncommitted changes — i.e. something to ship?
  let stagedChangesReady = false;
  if (succeeded) {
    const status = await execute(`cd ${WORKDIR} && git status --porcelain | head -5`, 30).catch(() => ({ exitCode: 1, result: '' }));
    stagedChangesReady = status.exitCode === 0 && (status.result ?? '').trim() !== '';
  }

  const reply = succeeded
    ? narrative || 'Done — take a look at the preview.'
    : narrative || "I hit a problem and couldn't finish that. Nothing was shipped — try rephrasing, or ask me again.";

  await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, role: 'agent', content: reply });
  await db
    .update(agentRuns)
    .set({ status: succeeded ? 'succeeded' : 'failed', costCents, finishedAt: new Date() })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  await setBuild(db, orgId, projectId, {
    ...(result?.sessionId ? { claudeSessionId: result.sessionId } : {}),
    stagedChangesReady,
  });

  return { runId, status: succeeded ? 'succeeded' : 'failed', costCents, reply, stagedChangesReady };
}
