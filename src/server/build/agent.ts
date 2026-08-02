import { ulid } from 'ulid';
import fs from 'node:fs/promises';
import type { Sandbox } from '@daytonaio/sdk';
import type { Db } from '../db/client.js';
import { agentMessages, agentMessageAttachments, agentRuns } from '../db/schema/index.js';
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
export type TurnAttachments = { images?: AttachedImage[]; files?: AttachedFile[] };

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
  attachments: TurnAttachments = {},
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

  // The owner's message lands on the thread first — the conversation is the record.
  const ownerMessageId = ulid();
  await db.insert(agentMessages).values({ id: ownerMessageId, orgId, projectId, role: 'owner', content: ownerText });

  // Image attachments are shown on the thread (bytes kept separate — see the
  // table's own note); a persistence hiccup must not sink the turn, since the
  // agent gets the images below regardless of whether the DB row landed.
  if (attachments.images?.length) {
    try {
      await db
        .insert(agentMessageAttachments)
        .values(attachments.images.map((img) => ({ id: ulid(), orgId, projectId, agentMessageId: ownerMessageId, mime: img.mime, dataBase64: img.dataBase64 })));
    } catch (err) {
      console.error(`could not persist attachments for ${orgId}/${projectId}:`, err);
    }
  }

  const runId = ulid();
  const model = cfg.model ?? 'sonnet';
  await db.insert(agentRuns).values({ id: runId, orgId, projectId, prompt: ownerText, model, status: 'running', startedAt: new Date() });

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
  const imagePaths = await writeAttachedImages(execute, uploadFile, runId, attachments.images ?? []);
  const addedFiles = await writeAddedFiles(execute, uploadFile, uploadLocalFile, runId, attachments.files ?? []);
  const cliPrompt = withAttachmentNotes(ownerText, imagePaths, addedFiles);

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
    await execute(startCommand(claudeCommand(cliPrompt, model, resumeSessionId), log, pid), 60);

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
