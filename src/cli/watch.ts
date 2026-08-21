import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CompanionApi } from './api.js';
import { parseClaudeSession } from './sessions/claude.js';
import { parseCodexSession } from './sessions/codex.js';
import { parseCursorSession } from './sessions/cursor.js';
import { parseGeminiCliSession } from './sessions/geminiCli.js';
import { toSummary } from './sessions/parse.js';
import { findSessionFiles, looksFinished, type Roots, type SessionFile } from './sessions/discover.js';
import { alreadySent, loadState, saveState, type WatchState } from './state.js';
import { commitDuring, repoFor } from './git.js';
import { checkSessionSummary, type SessionSummary } from '../shared/types/session.js';

/**
 * ONE PASS OF THE WATCH: find the finished sessions, summarise each, send the
 * summary, remember that it went.
 *
 * What leaves this machine is exactly what `checkSessionSummary` allows and
 * nothing else — and `--dry-run` prints it, so the promise is inspectable
 * rather than merely stated. What stays: every word of every conversation,
 * every diff, every file.
 *
 * A session that can't be read is REPORTED as unreadable rather than skipped.
 * That is the whole difference between a companion that can be trusted and one
 * that can't: the owner finds out that Thursday's sessions were unreadable on
 * Friday morning, from the brief, instead of never.
 */

export type WatchDeps = {
  api: CompanionApi;
  roots?: Roots;
  now?: () => number;
  readFile?: (path: string) => string;
  repoFor?: (cwd: string) => Promise<string | null>;
  commitDuring?: (cwd: string, from: Date, to: Date) => Promise<string | null>;
  statePath?: string;
  log?: (line: string) => void;
};

export type PassResult = { considered: number; sent: number; unreadable: number; skipped: number; failed: number };

/** Turn one finished log into the summary that will be sent, or an honest unreadable. */
export async function summarise(file: SessionFile, deps: WatchDeps): Promise<SessionSummary> {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const findRepo = deps.repoFor ?? repoFor;
  const findCommit = deps.commitDuring ?? commitDuring;

  let text: string;
  try {
    text = read(file.path);
  } catch (err) {
    return {
      agent: file.agent,
      // The file's NAME, never its path: a summary should not carry the shape
      // of someone's home directory.
      session_id: file.idHint ?? path.basename(file.path),
      outcome: 'unreadable',
      detail: `I couldn't open the log: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  // One parser per tool, and every one of them returns a reason rather than
  // throwing — so an unverified reader failing on a format that moved becomes
  // a reported `unreadable`, not a crashed pass that loses the whole night.
  const PARSERS = {
    'claude-code': parseClaudeSession,
    codex: parseCodexSession,
    cursor: parseCursorSession,
    'gemini-cli': parseGeminiCliSession,
  } as const;
  let parsed;
  try {
    parsed = PARSERS[file.agent](text, file.idHint);
  } catch (err) {
    parsed = { ok: false as const, reason: `the reader for ${file.agent} failed on this log: ${err instanceof Error ? err.message : 'unknown error'}` };
  }
  if (!parsed.ok) {
    return {
      agent: file.agent,
      session_id: file.idHint ?? path.basename(file.path),
      outcome: 'unreadable',
      detail: parsed.reason,
    };
  }

  const summary = toSummary(parsed.session);
  const cwd = parsed.session.cwd;
  if (cwd) {
    const repo = await findRepo(cwd).catch(() => null);
    if (repo) summary.repo = repo;
    const from = parsed.session.startedAt;
    const to = parsed.session.endedAt;
    if (from && to) {
      const commit = await findCommit(cwd, from, to).catch(() => null);
      if (commit) {
        summary.commit_sha = commit;
        // A commit landed while it was open. That is a correlation and the
        // record says so; it is not a claim that this session authored it.
        summary.outcome = 'shipped';
      }
    }
  }
  return summary;
}

export async function watchOnce(deps: WatchDeps): Promise<PassResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const state: WatchState = loadState(deps.statePath);
  const files = findSessionFiles(deps.roots);
  const result: PassResult = { considered: files.length, sent: 0, unreadable: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    if (!looksFinished(file, now())) {
      result.skipped += 1;
      continue;
    }
    if (alreadySent(state, file.path, file.size, file.mtimeMs)) {
      result.skipped += 1;
      continue;
    }

    const summary = await summarise(file, deps);
    const checked = checkSessionSummary(summary);
    if (!checked.ok) {
      // Our own summary failing our own contract is a bug, not a session
      // problem — say so here rather than sending something malformed.
      log(`could not summarise ${file.path}: ${checked.error}`);
      result.failed += 1;
      continue;
    }

    const sent = await deps.api.sendSession(checked.value);
    if (!sent.ok) {
      log(`could not send ${file.path}: ${sent.error}`);
      result.failed += 1;
      continue;
    }

    if (summary.outcome === 'unreadable') result.unreadable += 1;
    result.sent += 1;
    state.files[file.path] = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      sessionId: checked.value.session_id,
      sentAt: new Date(now()).toISOString(),
    };
    log(
      `${summary.outcome === 'unreadable' ? 'reported unreadable' : 'sent'}: ${file.agent} ${checked.value.session_id}` +
        `${sent.value.project_id ? ` → ${sent.value.project_id}` : sent.value.note ? ' → (no project matched)' : ''}`,
    );
  }

  saveState(state, deps.statePath);
  return result;
}

/** What `--dry-run` prints: exactly what would have been sent, and nothing more. */
export async function dryRun(deps: WatchDeps): Promise<SessionSummary[]> {
  const now = deps.now ?? Date.now;
  const files = findSessionFiles(deps.roots).filter((f) => looksFinished(f, now()));
  const out: SessionSummary[] = [];
  for (const file of files) out.push(await summarise(file, deps));
  return out;
}
