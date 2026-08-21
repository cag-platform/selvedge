import type { SessionAgent, SessionOutcome, SessionSummary } from '../../shared/types/session.js';
import { MAX_FILES, MAX_INTENT_CHARS, MAX_TOOL_KINDS } from '../../shared/types/session.js';

/**
 * READING SOMEONE ELSE'S LOG.
 *
 * Both formats here are undocumented, written by tools that change them without
 * notice, and full of shapes that exist in one version and not the next. So
 * every parser in this directory is written to the same three rules:
 *
 *  1. NEVER THROW. A line that doesn't parse is skipped; a whole file that
 *     doesn't parse returns `unreadable`, which is reported to Selvedge and
 *     said out loud in the brief. The failure mode to avoid is not "it crashed"
 *     — it is "it quietly narrated three of yesterday's five sessions".
 *  2. NEVER GUESS. If the session id isn't there, there is no session to
 *     report. If the cost isn't stated, the summary doesn't carry one.
 *  3. NEVER TAKE MORE THAN THE SUMMARY. The parsers see every word of a
 *     conversation and are allowed to keep: the first ask (bounded), file
 *     paths, tool names and counts, timestamps, and what the tool said things
 *     cost. Assistant prose, file contents and diffs are read and discarded.
 */

export type ParsedSession = {
  agent: SessionAgent;
  sessionId: string;
  cwd: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  intent: string | null;
  files: string[];
  tools: Record<string, number>;
  costUsd: number | null;
  /** The tool itself reported a failure somewhere in the log. */
  sawError: boolean;
  /** How much actually happened — used to tell an abandoned session from a finished one. */
  assistantTurns: number;
};

export type ParseResult = { ok: true; session: ParsedSession } | { ok: false; reason: string };

/** JSON per line, tolerating partial writes and anything that isn't JSON at all. */
export function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch {
      // A half-written last line while the tool is still running. Skip it.
    }
  }
  return out;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function whenOf(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A path recorded relative to the session's directory, so a summary never carries someone's home folder layout. */
export function relativeTo(cwd: string | null, file: string): string {
  if (!cwd) return file;
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function addTool(tools: Record<string, number>, name: string): void {
  if (Object.keys(tools).length >= MAX_TOOL_KINDS && !(name in tools)) return;
  tools[name] = (tools[name] ?? 0) + 1;
}

export function addFile(files: Set<string>, file: string): void {
  if (files.size >= MAX_FILES) return;
  files.add(file);
}

export function boundIntent(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_INTENT_CHARS);
}

/**
 * How a session ended, from the outside. `shipped` is decided later, by the
 * watcher, and only when a commit actually landed while it was open — the
 * parsers can't see git and must not claim to.
 */
export function outcomeOf(session: ParsedSession): SessionOutcome {
  if (session.sawError) return 'error';
  if (session.assistantTurns === 0 && session.files.length === 0) return 'abandoned';
  return 'ended';
}

/** The summary a parsed session becomes, before the watcher adds repo and commit. */
export function toSummary(session: ParsedSession): SessionSummary {
  return {
    agent: session.agent,
    session_id: session.sessionId,
    outcome: outcomeOf(session),
    ...(session.startedAt ? { started_at: session.startedAt.toISOString() } : {}),
    ...(session.endedAt ? { ended_at: session.endedAt.toISOString() } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.intent ? { intent: session.intent } : {}),
    ...(session.files.length ? { files_touched: session.files } : {}),
    ...(Object.keys(session.tools).length ? { tools_run: session.tools } : {}),
    ...(session.costUsd !== null ? { cost_usd: session.costUsd } : {}),
  };
}
