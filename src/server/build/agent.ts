import { ulid } from 'ulid';
import fs from 'node:fs/promises';
import type { Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { agentMessages, agentMessageAttachments, agentRuns } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { getBuild, setBuild } from './store.js';
import { ensureSandbox, WORKDIR, PATH_PREFIX, type SandboxConfig } from './sandbox.js';
import { ensureWorkshopThread } from '../threads/store.js';
import { driverFor } from '../runner/agents/driver.js';
import { agentById, type AgentId } from '../../shared/agents.js';
import { MAX_TOOL_EVENTS, type RunRecord, type ToolEvent } from '../../shared/types/toolEvent.js';

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

/** Write a file's bytes into the sandbox at an absolute path (Daytona's fs.uploadFile). */
export type UploadToSandbox = (absPath: string, data: Buffer) => Promise<void>;
/** Stream a LOCAL file straight into the sandbox — no whole-file buffering, for large attachments. */
export type UploadLocalFileToSandbox = (absPath: string, localPath: string) => Promise<void>;

/** A screenshot or mockup: shown with the Read tool, never lands in the project. Small — inline is fine. */
export type AttachedImage = { mime: string; dataBase64: string };
/**
 * A doc, code file, or .zip: dropped straight into the project (zips are
 * extracted). Small files travel inline; anything larger is staged to local
 * disk first (see build/uploads.ts) and referenced by localPath so it's
 * streamed into the sandbox rather than held whole in memory — that's how a
 * multi-hundred-MB export stays safe to attach.
 */
export type AttachedFile = { name: string; mime?: string } & ({ dataBase64: string } | { localPath: string });
export type TurnOptions = {
  images?: AttachedImage[];
  files?: AttachedFile[];
  /**
   * 'plan' is the iteration station: the agent explores read-only and comes
   * back with a numbered plan — no edits, nothing staged, nothing to ship.
   * For going back and forth on an idea before committing to a build.
   */
  mode?: 'build' | 'plan';
  /**
   * Which conversation this turn belongs to. Omitted means the project's
   * workshop thread — the one migration 0022 backfilled, so a turn asked for
   * the old way still lands in the history it belongs to.
   */
  threadId?: string;
  /**
   * A handoff payload (handoff/compose.ts) to start this turn with — set on the
   * first turn after the thread changed builders, so the incoming agent begins
   * where the last one stopped instead of cold.
   */
  handoff?: string;
};

export type AgentTurnConfig = SandboxConfig & {
  model?: string;
  /** Which builder runs this turn. Defaults to Claude Code, the only one there used to be. */
  agent?: AgentId;
  /** Codex's fuel. Absent means Codex can't run here, and the thread is told so plainly. */
  openaiApiKey?: string;
};

export type AgentTurnOutcome = {
  runId: string;
  /** Which builder ran it. */
  agent: AgentId;
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

/** Screenshots live outside the project so they never land in a checkpoint or ship. */
const UPLOADS_DIR = '/workspace/.selvedge/uploads';

function imageExt(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

/** Reduce an uploaded name to a safe basename (no path, no traversal). */
function safeBasename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length ? cleaned : 'file';
}

function isZipFile(file: AttachedFile): boolean {
  return /\.zip$/i.test(file.name) || file.mime === 'application/zip' || file.mime === 'application/x-zip-compressed';
}

/** Write attached screenshots into the sandbox and return their absolute paths. */
async function writeAttachedImages(execute: ExecuteInSandbox, upload: UploadToSandbox, runId: string, images: AttachedImage[]): Promise<string[]> {
  if (!images.length) return [];
  await execute(`mkdir -p ${UPLOADS_DIR}`, 30).catch(() => undefined);
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const p = `${UPLOADS_DIR}/${runId}-${i}.${imageExt(images[i]!.mime)}`;
    await upload(p, Buffer.from(images[i]!.dataBase64, 'base64'));
    paths.push(p);
  }
  return paths;
}

/**
 * Drop user-added files into the project. Plain files land at the project
 * root under a safe basename; .zip archives are extracted in place (the
 * archive itself is staged in /tmp and removed). Returns a human summary of
 * what was added, for the agent's prompt note. Never throws — a bad file
 * degrades to a note that it failed, not a failed turn. A staged (localPath)
 * file's local temp copy is deleted once it's been dealt with, success or
 * not — it was only ever meant to live between "attach" and this turn.
 */
async function writeAddedFiles(
  execute: ExecuteInSandbox,
  upload: UploadToSandbox,
  uploadLocal: UploadLocalFileToSandbox,
  runId: string,
  files: AttachedFile[],
): Promise<string[]> {
  if (!files.length) return [];
  await execute(`mkdir -p ${WORKDIR}`, 30).catch(() => undefined);
  const added: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const staged = 'localPath' in file;
    try {
      if (isZipFile(file)) {
        const tmp = `/tmp/selvedge-upload-${runId}-${i}.zip`;
        if (staged) await uploadLocal(tmp, file.localPath);
        else await upload(tmp, Buffer.from(file.dataBase64, 'base64'));
        const res = await execute(
          `cd ${WORKDIR} && (unzip -o -q ${shellQuote(tmp)} -d ${WORKDIR} || python3 -m zipfile -e ${shellQuote(tmp)} ${WORKDIR}); rm -f ${shellQuote(tmp)}`,
          180,
        );
        added.push(res.exitCode === 0 ? `${file.name} (extracted into the project)` : `${file.name} (upload failed to extract)`);
      } else {
        const name = safeBasename(file.name);
        if (staged) await uploadLocal(`${WORKDIR}/${name}`, file.localPath);
        else await upload(`${WORKDIR}/${name}`, Buffer.from(file.dataBase64, 'base64'));
        added.push(name);
      }
    } catch (err) {
      console.error(`could not write uploaded file ${file.name}:`, err);
      added.push(`${file.name} (upload failed)`);
    } finally {
      if (staged) await fs.unlink(file.localPath).catch(() => undefined);
    }
  }
  return added;
}

/**
 * The iteration station's framing. Belt-and-braces with the skipped staging
 * check below: this tells the agent not to touch anything, and the caller
 * treats a plan turn as producing nothing to ship regardless.
 */
function planWrap(prompt: string): string {
  return [
    'You are helping think this through BEFORE any code is written. Do NOT create, edit, move, or delete any files,',
    'and do NOT run commands that change anything (no installs, no migrations, no starting servers). You may read',
    'files and explore the project read-only to understand it.',
    '',
    'Answer in plain English, for a smart person who does not read code. If the idea below is vague or could go',
    'several ways, say what you would assume and name the choice you would want settled. Then give a short, numbered',
    'plan of what building it would actually involve, and flag anything that looks risky, expensive, or bigger than',
    'it sounds. End with the one thing you would do first.',
    '',
    'The idea:',
    prompt,
  ].join('\n');
}

/** Point the agent at what the owner attached — screenshots (Read tool) and added files. */
function withAttachmentNotes(prompt: string, imagePaths: string[], addedFiles: string[]): string {
  let out = prompt;
  if (imagePaths.length) {
    const plural = imagePaths.length > 1;
    out += `\n\nThe owner attached ${imagePaths.length} image${plural ? 's' : ''}; view ${plural ? 'them' : 'it'} with the Read tool to understand the request:\n${imagePaths.map((p) => `- ${p}`).join('\n')}`;
  }
  if (addedFiles.length) {
    out += `\n\nThe owner added the following file(s) to the project at ${WORKDIR}; review and use them as appropriate:\n${addedFiles.map((f) => `- ${f}`).join('\n')}`;
  }
  return out;
}

export async function runAgentTurn(
  db: Db,
  orgId: string,
  projectId: string,
  ownerText: string,
  cfg: AgentTurnConfig,
  options: TurnOptions = {},
  deps: {
    execute?: ExecuteInSandbox;
    uploadFile?: UploadToSandbox;
    uploadLocalFile?: UploadLocalFileToSandbox;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<AgentTurnOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  // The run id is minted before anything lands on the thread, so every message
  // this turn writes — owner, activity, reply — carries it and the thread is
  // joinable to the run it belongs to.
  const runId = ulid();

  // Which conversation this turn is part of. Every row this turn writes carries
  // it, so the thread reads back whole even once a project holds several.
  const threadId = options.threadId ?? (await ensureWorkshopThread(db, orgId, projectId, cfg.model)).id;

  // Which builder is running this turn, and can it run here at all? An agent
  // this deployment has no fuel for is said plainly on the thread — never a
  // silent fallback to a different one, which would make the switcher a lie.
  const agent: AgentId = cfg.agent ?? 'claude-code';
  const driver = driverFor(agent, { openaiApiKey: cfg.openaiApiKey });
  if (!driver) {
    const name = agentById(agent)?.name ?? agent;
    const reply = `${name} isn't switched on here yet — there's no key for it, so I can't run your message through it. Switch this thread back to Claude Code and I'll pick it up.`;
    const failedRunId = ulid();
    await db.insert(agentRuns).values({ id: failedRunId, orgId, projectId, threadId, agent, prompt: ownerText, status: 'failed', startedAt: new Date(), finishedAt: new Date() });
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, threadId, role: 'owner', content: ownerText, runId: failedRunId });
    await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, threadId, role: 'agent', content: reply, runId: failedRunId });
    return { runId: failedRunId, agent, status: 'failed', costCents: 0, reply, stagedChangesReady: false };
  }

  // The owner's message lands on the thread first — the conversation is the record.
  const ownerMessageId = ulid();
  await db.insert(agentMessages).values({ id: ownerMessageId, orgId, projectId, threadId, role: 'owner', content: ownerText, runId });

  // Image attachments are shown on the thread (bytes kept separate — see the
  // table's own note); a persistence hiccup must not sink the turn, since the
  // agent gets the images below regardless of whether the DB row landed.
  if (options.images?.length) {
    try {
      await db
        .insert(agentMessageAttachments)
        .values(options.images.map((img) => ({ id: ulid(), orgId, projectId, agentMessageId: ownerMessageId, mime: img.mime, dataBase64: img.dataBase64 })));
    } catch (err) {
      console.error(`could not persist attachments for ${orgId}/${projectId}:`, err);
    }
  }

  const model = cfg.model ?? 'sonnet';
  // The prompt column doubles as the run's kind marker (ship.ts writes
  // "ship: …"); a plan turn is tagged the same way so the workshop can tell
  // thinking apart from building without another column.
  const runPrompt = options.mode === 'plan' ? `plan: ${ownerText}` : ownerText;
  await db.insert(agentRuns).values({ id: runId, orgId, projectId, threadId, agent, prompt: runPrompt, model, status: 'running', startedAt: new Date() });

  // execute and uploadFile share one lazily-created sandbox — created on first
  // use, never twice, and never at all when a test injects both.
  let sandboxPromise: Promise<Sandbox> | null = null;
  const getSandbox = (): Promise<Sandbox> => (sandboxPromise ??= ensureSandbox(db, orgId, projectId, cfg));

  const execute: ExecuteInSandbox =
    deps.execute ??
    (async (command: string, timeoutSec: number) => {
      const sandbox = await getSandbox();
      return sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
    });
  const uploadFile: UploadToSandbox =
    deps.uploadFile ??
    (async (absPath: string, data: Buffer) => {
      const sandbox = await getSandbox();
      await sandbox.fs.uploadFile(data, absPath);
    });
  // The streaming overload: takes a LOCAL path and streams it in, so a large
  // staged upload never has to be held whole in this process's memory.
  const uploadLocalFile: UploadLocalFileToSandbox =
    deps.uploadLocalFile ??
    (async (absPath: string, localPath: string) => {
      const sandbox = await getSandbox();
      await sandbox.fs.uploadFile(localPath, absPath);
    });

  // Write what the owner attached BEFORE the turn starts, once — a retried
  // attempt (stale-session case below) reuses the same files, never re-writes.
  const imagePaths = await writeAttachedImages(execute, uploadFile, runId, options.images ?? []);
  const addedFiles = await writeAddedFiles(execute, uploadFile, uploadLocalFile, runId, options.files ?? []);
  const planning = options.mode === 'plan';
  const withNotes = withAttachmentNotes(planning ? planWrap(ownerText) : ownerText, imagePaths, addedFiles);
  // The handover, when there is one, goes at the head: what the project is,
  // what has happened, where the work stands — then the ask itself.
  const cliPrompt = options.handoff ? `${options.handoff}\n\n---\n\n${withNotes}` : withNotes;

  // The live activity row: inserted once, updated in place as the log grows.
  // `inserted` and the shown count are tracked separately, and a retried
  // attempt (fresh log file, so fewer lines than the first attempt showed)
  // carries the first attempt's lines as a prefix — the feed only ever
  // appends. Folding these into one counter was a real bug: the retry's
  // shorter log stalled updates until it outgrew the old count, then the
  // row's tail jumped — the owner watched the feed rewind.
  const activityId = ulid();
  let activityInserted = false;
  let activityShown = 0;
  let priorAttemptLines: string[] = [];
  const showActivity = async (log: string) => {
    const lines = [...priorAttemptLines, ...driver.events(log).tools.map((t) => t.detail)];
    if (lines.length === activityShown) return;
    const content = lines.slice(-30).join('\n');
    if (!activityInserted) {
      await db.insert(agentMessages).values({ id: activityId, orgId, projectId, threadId, role: 'activity', content, runId });
      activityInserted = true;
    } else {
      await db.update(agentMessages).set({ content }).where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, activityId)));
    }
    activityShown = lines.length;
  };

  /** Run one attempt to completion, streaming activity. Returns the full log, or null on timeout. */
  let setupDone = false;
  const attempt = async (resumeSessionId: string | null): Promise<string | null> => {
    // Install the CLI if this agent needs it. Once per turn, best-effort: a
    // failure here surfaces as the turn failing to produce a result, with the
    // CLI's own words, rather than as an exception nobody sees.
    if (driver.setupCommand && !setupDone) {
      setupDone = true;
      await execute(driver.setupCommand, 300).catch(() => undefined);
    }
    const suffix = ulid().toLowerCase();
    const log = `/tmp/selvedge-turn-${suffix}.log`;
    const pid = `/tmp/selvedge-turn-${suffix}.pid`;
    await execute(startCommand(driver.command(cliPrompt, { model, resumeSessionId, mode: planning ? 'plan' : 'build' }), log, pid), 60);

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
  // Each builder has its own session inside the shared sandbox: resuming the
  // other one's would hand this agent someone else's transcript.
  const priorSessionId = agent === 'codex' ? (prior?.codexSessionId ?? null) : (prior?.claudeSessionId ?? null);
  let log = await attempt(priorSessionId);

  // A stale session (sandbox was recreated; the session file died with it)
  // fails the resume. Retry once fresh instead of failing the owner's turn.
  // The failed attempt still spent real money — harvest its cost before the
  // log is replaced, or the turn under-reports. "Never a surprise bill" is
  // broken just as surely by an under-count as an over-count.
  let priorAttemptCostUsd = 0;
  let priorAttemptTools: ToolEvent[] = [];
  if (log !== null && exitCodeOf(log) !== 0 && priorSessionId) {
    priorAttemptCostUsd = driver.result(log).costUsd;
    priorAttemptTools = driver.events(log).tools;
    priorAttemptLines = priorAttemptTools.map((t) => t.detail);
    await setBuild(db, orgId, projectId, agent === 'codex' ? { codexSessionId: null } : { claudeSessionId: null });
    log = await attempt(null);
  }

  const result = log !== null ? driver.result(log) : null;
  const narrative = log !== null ? driver.text(log) : '';
  const succeeded = log !== null && exitCodeOf(log) === 0 && result !== null && !result.isError;
  const costCents = Math.max(0, Math.round((priorAttemptCostUsd + (result?.costUsd ?? 0)) * 100));

  // Does the sandbox now hold uncommitted changes — i.e. something to ship?
  // A plan turn is thinking out loud, so it never marks work ready to ship —
  // and never CLEARS a real staged change that was already waiting, either.
  let stagedChangesReady = prior?.stagedChangesReady ?? false;
  let changedPaths: string[] | null = null;
  if (succeeded && !planning) {
    const status = await execute(`cd ${WORKDIR} && git status --porcelain | head -5`, 30).catch(() => ({ exitCode: 1, result: '' }));
    stagedChangesReady = status.exitCode === 0 && (status.result ?? '').trim() !== '';
    // The files this turn touched — the same union ship judges. Recorded on the
    // run row so a change is traceable to the run that made it. Best-effort: a
    // failed listing records nothing rather than something wrong.
    if (stagedChangesReady) {
      const diff = await execute(
        `cd ${WORKDIR} && { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u`,
        60,
      ).catch(() => null);
      if (diff && diff.exitCode === 0) {
        const paths = (diff.result ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
        if (paths.length) changedPaths = paths;
      }
    }
  }

  // The flight recorder: the run's full structured record onto the activity
  // row's meta — every tool use with its outcome, bounded, joined to the run.
  // The display content keeps its last-30 tail; this is the durable evidence
  // that outlives the sandbox (whose copy of the log dies in minutes).
  if (activityInserted && log !== null) {
    const finalEvents = driver.events(log);
    const allTools = [...priorAttemptTools, ...finalEvents.tools];
    const record: RunRecord = {
      run_id: runId,
      tools: allTools.slice(0, MAX_TOOL_EVENTS),
      truncated: finalEvents.truncated || allTools.length > MAX_TOOL_EVENTS,
    };
    await db
      .update(agentMessages)
      .set({ meta: record })
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.id, activityId)))
      .catch(() => undefined); // the record is evidence, not a gate — never sink the turn
  }

  // An agent that doesn't report what a turn used leaves a zero in the cost
  // watch. Saying so is the difference between an unknown and a free turn.
  const costNote = succeeded && result && !result.costReported ? `\n\n(${agentById(agent)?.name ?? agent} didn't report what that turn cost, so it isn't in the cost watch below.)` : '';
  const reply = succeeded
    ? (narrative || (planning ? 'Here is how I would approach it.' : 'Done — take a look at the preview.')) + costNote
    : log === null
      ? 'That took too long, so I stopped it. Nothing was shipped — try asking for a smaller piece of it.'
      : narrative || "I hit a problem and couldn't finish that. Nothing was shipped — try rephrasing, or ask me again.";

  await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, threadId, role: 'agent', content: reply, runId });
  await db
    .update(agentRuns)
    .set({
      status: succeeded ? 'succeeded' : 'failed',
      costCents,
      finishedAt: new Date(),
      ...(changedPaths ? { changedPaths } : {}),
    })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  await setBuild(db, orgId, projectId, {
    ...(result?.sessionId ? (agent === 'codex' ? { codexSessionId: result.sessionId } : { claudeSessionId: result.sessionId }) : {}),
    stagedChangesReady,
  });

  return { runId, agent, status: succeeded ? 'succeeded' : 'failed', costCents, reply, stagedChangesReady };
}
