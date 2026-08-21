import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SessionAgent } from '../../shared/types/session.js';

/**
 * Finding the logs, and deciding which ones are finished.
 *
 * Neither tool announces "this session has ended" — the process just stops
 * writing. So "ended" here means "nothing has been appended for a while", which
 * is a heuristic and is documented as one. Getting it wrong in one direction
 * (waiting too long) delays a summary; getting it wrong in the other would
 * report a session while its author is still typing, which is why the default
 * is generous.
 */

export const IDLE_MINUTES = 5;

export type SessionFile = {
  agent: SessionAgent;
  path: string;
  size: number;
  mtimeMs: number;
  /** The tool's session id when the filename carries it — a fallback if the log doesn't say. */
  idHint: string | undefined;
};

export type Roots = { claude?: string; codex?: string; cursor?: string; gemini?: string };

/**
 * Where each tool keeps its logs. Claude and Codex are verified. Cursor and
 * Gemini CLI are NOT — their roots are a best understanding, which is why both
 * are overridable in the companion's config: a root that is wrong finds nothing
 * and looks exactly like a quiet week, and the fix for that has to be in the
 * owner's hands.
 *
 * Cursor's IDE chat lives in a SQLite workspace database that this deliberately
 * does not open. Only its agent CLI's own session directory is read.
 */
export function defaultRoots(home = homedir()): Required<Roots> {
  return {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    cursor: path.join(home, '.cursor', 'sessions'),
    gemini: path.join(home, '.gemini', 'tmp'),
  };
}

/** Every file with one of these extensions under a directory tree, depth-limited so a symlink loop can't wander off. */
function filesUnder(dir: string, extensions: readonly string[], depth = 0): string[] {
  if (depth > 5) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // the tool isn't installed, or has never run here
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) found.push(...filesUnder(full, extensions, depth + 1));
    else if (extensions.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

function fileInfo(agent: SessionAgent, file: string, idHint: string | undefined): SessionFile | null {
  try {
    const stats = statSync(file);
    return { agent, path: file, size: stats.size, mtimeMs: stats.mtimeMs, idHint };
  } catch {
    return null;
  }
}

/**
 * Claude names the file after the session id. Codex names it
 * rollout-<timestamp>-<uuid>.jsonl, so the id is the trailing UUID and nothing
 * else — a looser pattern would happily return a slice of the date.
 */
function idFromName(agent: SessionAgent, file: string): string | undefined {
  const base = path.basename(file).replace(/\.(jsonl|json)$/i, '');
  if (agent === 'claude-code') return base;
  // Cursor and Gemini CLI name files various ways; a trailing UUID is the only
  // thing we'd stand behind, and where there isn't one the parser has to find
  // the id in the log itself or report the session unreadable.
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base)?.[1];
}

export function findSessionFiles(roots: Roots = defaultRoots()): SessionFile[] {
  const found: SessionFile[] = [];
  for (const file of roots.claude ? filesUnder(roots.claude, ['.jsonl']) : []) {
    const info = fileInfo('claude-code', file, idFromName('claude-code', file));
    if (info) push(found, info);
  }
  for (const file of roots.codex ? filesUnder(roots.codex, ['.jsonl']) : []) {
    if (!path.basename(file).startsWith('rollout-')) continue;
    const info = fileInfo('codex', file, idFromName('codex', file));
    if (info) push(found, info);
  }
  // Unverified readers, both of them, and both take .json as well as .jsonl
  // because neither tool has settled on one. An empty result here means one of
  // two things — the tool isn't used, or the root moved — and only the owner
  // can tell those apart, which is what `selvedge watch --dry-run` is for.
  for (const file of roots.cursor ? filesUnder(roots.cursor, ['.jsonl', '.json']) : []) {
    const info = fileInfo('cursor', file, idFromName('cursor', file));
    if (info) push(found, info);
  }
  for (const file of roots.gemini ? filesUnder(roots.gemini, ['.jsonl', '.json']) : []) {
    // Gemini CLI's tmp tree holds more than conversations; only the logs and
    // saved chats are session material.
    const base = path.basename(file);
    if (!/^logs?\.jsonl?$/i.test(base) && !file.includes(`${path.sep}chats${path.sep}`)) continue;
    const info = fileInfo('gemini-cli', file, idFromName('gemini-cli', file));
    if (info) push(found, info);
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** An empty log is not a session; it is a file the tool made and never used. */
function push(into: SessionFile[], file: SessionFile): void {
  if (file.size > 0) into.push(file);
}

/** Has this session been quiet long enough to be called finished? */
export function looksFinished(file: SessionFile, now = Date.now(), idleMinutes = IDLE_MINUTES): boolean {
  return now - file.mtimeMs >= idleMinutes * 60_000;
}
