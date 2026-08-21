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

export type Roots = { claude?: string; codex?: string };

export function defaultRoots(home = homedir()): Required<Roots> {
  return { claude: path.join(home, '.claude', 'projects'), codex: path.join(home, '.codex', 'sessions') };
}

/** Every *.jsonl under a directory tree, depth-limited so a symlink loop can't wander off. */
function jsonlFilesUnder(dir: string, depth = 0): string[] {
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
    if (stats.isDirectory()) found.push(...jsonlFilesUnder(full, depth + 1));
    else if (entry.endsWith('.jsonl')) found.push(full);
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
  const base = path.basename(file, '.jsonl');
  if (agent === 'claude-code') return base;
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base)?.[1];
}

export function findSessionFiles(roots: Roots = defaultRoots()): SessionFile[] {
  const found: SessionFile[] = [];
  for (const file of roots.claude ? jsonlFilesUnder(roots.claude) : []) {
    const info = fileInfo('claude-code', file, idFromName('claude-code', file));
    if (info) found.push(info);
  }
  for (const file of roots.codex ? jsonlFilesUnder(roots.codex) : []) {
    if (!path.basename(file).startsWith('rollout-')) continue;
    const info = fileInfo('codex', file, idFromName('codex', file));
    if (info) found.push(info);
  }
  return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Has this session been quiet long enough to be called finished? */
export function looksFinished(file: SessionFile, now = Date.now(), idleMinutes = IDLE_MINUTES): boolean {
  return now - file.mtimeMs >= idleMinutes * 60_000;
}
