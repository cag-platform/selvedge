import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, PATH_PREFIX, type SandboxConfig } from './sandbox.js';
import { claudeCommand, parseResult, parseAssistantText, parseToolActivity } from '../runner/daytona/agentCommand.js';

/**
 * One workshop turn: the owner says what they want in plain English, the agent
 * does it in the project's persistent sandbox, and the conversation continues
 * across turns (--resume), so iteration is "now make it darker", not starting
 * over. Every turn's real cost is recorded in cents on its run row — the
 * founder's cost-watch rule applied to the agent as well as the sandbox.
 *
 * STREAMING: the turn runs backgrounded in the sandbox, writing stream-json to a
 * log; this loop polls the log every few seconds, parses the tool activity, and
 * updates a live `activity` row on the thread in place — so the owner watches
 * the actual work ("Editing src/App.tsx", "Running: npm test"), not a spinner.
 * The page's existing polling picks it up with no extra infrastructure.
 *
 * The command execution is injectable so the whole orchestration is testable
 * without Daytona. A stale --resume (the session file died with a recreated
 * sandbox) is retried once fresh rather than failing the turn.
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

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 2500;

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Start the turn detached: stream-json to a log, pid saved, exit code appended when done. */
function startCommand(inner: string, log: string, pid: string): string {
  return `${PATH_PREFIX} nohup bash -c ${shellQuote(`${inner}; echo "__EXIT:$?" >> ${log}`)} >> ${log} 2>&1 < /dev/null & echo $! > ${pid}`;
}

/** One poll: the whole log so far, plus whether the process still runs. */
function pollCommand(log: string, pid: string): string {
  return `cat ${log} 2>/dev/null; echo "__STATE:$(kill -0 $(cat ${pid} 2>/dev/null) 2>/dev/null && echo ALIVE || echo DONE)"`;
}

function splitPoll(out: string): { log: string; done: boolean } {
  const marker = out.lastIndexOf('__STATE:');
  const log = marker >= 0 ? out.slice(0, marker) : out;
  const done = marker >= 0 ? out.slice(marker).includes('DONE') : false;
  return { log, done };
}

function exitCodeOf(log: string): number | null {
  const m = /__EXIT:(\d+)/.exec(log);
  return m ? Number(m[1]) : null;
}

export async function runAgentTurn(
  db: Db,
  orgId: string,
  projectId: string,
  ownerText: string,
  cfg: AgentTurnConfig,
  deps: { execute?: ExecuteInSandbox; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<AgentTurnOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

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

  // The live activity row: inserted once, updated in place as the log grows.
  const activityId = ulid();
  let activityShown = 0;
  const showActivity = async (log: string) => {
    const lines = parseToolActivity(log);
    if (lines.length === activityShown) return;
    const content = lines.slice(-30).join('\n');
    if (activityShown === 0) {
      await db.insert(agentMessages).values({ id: activityId, orgId, projectId, role: 'activity', content });
    } else {
      await db.update(agentMessages).set({ content }).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, activityId)));
    }
    activityShown = lines.length;
  };

  /** Run one attempt to completion, streaming activity. Returns the full log, or null on timeout. */
  const attempt = async (resumeSessionId: string | null): Promise<string | null> => {
    const suffix = ulid().toLowerCase();
    const log = `/tmp/selvedge-turn-${suffix}.log`;
    const pid = `/tmp/selvedge-turn-${suffix}.pid`;
    await execute(startCommand(claudeCommand(ownerText, model, resumeSessionId), log, pid), 60);

    const startedAt = now();
    while (now() - startedAt < TURN_TIMEOUT_MS) {
      await sleep(POLL_MS);
      const poll = await execute(pollCommand(log, pid), 60).catch(() => null);
      if (!poll) continue; // a flaky poll is not a failed turn
      const { log: soFar, done } = splitPoll(poll.result ?? '');
      await showActivity(soFar).catch(() => undefined);
      if (done) return soFar;
    }
    // Timed out: kill the process; the honest failure lands below.
    await execute(`kill -TERM $(cat ${pid} 2>/dev/null) 2>/dev/null || true`, 30).catch(() => undefined);
    return null;
  };

  const prior = await getBuild(db, orgId, projectId);
  let log = await attempt(prior?.claudeSessionId ?? null);

  // A stale session (sandbox was recreated; the session file died with it)
  // fails the resume. Retry once fresh instead of failing the owner's turn.
  if (log !== null && exitCodeOf(log) !== 0 && prior?.claudeSessionId) {
    await setBuild(db, orgId, projectId, { claudeSessionId: null });
    log = await attempt(null);
  }

  const result = log !== null ? parseResult(log) : null;
  const narrative = log !== null ? parseAssistantText(log) : '';
  const succeeded = log !== null && exitCodeOf(log) === 0 && result !== null && !result.isError;
  const costCents = Math.max(0, Math.round((result?.totalCostUsd ?? 0) * 100));

  // Does the sandbox now hold uncommitted changes — i.e. something to ship?
  let stagedChangesReady = false;
  if (succeeded) {
    const status = await execute(`cd ${WORKDIR} && git status --porcelain | head -5`, 30).catch(() => ({ exitCode: 1, result: '' }));
    stagedChangesReady = status.exitCode === 0 && (status.result ?? '').trim() !== '';
  }

  const reply = succeeded
    ? narrative || 'Done — take a look at the preview.'
    : log === null
      ? 'That took too long, so I stopped it. Nothing was shipped — try asking for a smaller piece of it.'
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
