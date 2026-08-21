import { addFile, addTool, boundIntent, relativeTo, str, whenOf, type ParseResult, type ParsedSession } from './parse.js';

/**
 * Gemini CLI's session log.
 *
 * UNVERIFIED. The Claude Code and Codex readers were written against real logs
 * from those tools; this one is written against Gemini CLI's format as
 * understood, and has not been proved against a log this codebase has seen.
 * That is stated here, in docs/companion.md, and — the part that matters — in
 * the behaviour: a file this cannot read is reported as `unreadable` with a
 * reason, exactly like any other, so the failure of an unverified reader shows
 * up in the morning brief as "I couldn't read four Gemini sessions" instead of
 * as silence that looks like "you didn't use it".
 *
 * Two container shapes are accepted, because the tool has written both: a JSON
 * array of entries (`logs.json`), and one JSON object per line. Everything
 * inside is read defensively — a field that isn't there is a field we don't
 * report.
 */

type Entry = Record<string, unknown>;

/** A JSON array, or JSON-per-line. Neither is assumed; both are tried. */
export function entriesOf(text: string): Entry[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((e): e is Entry => !!e && typeof e === 'object' && !Array.isArray(e));
    } catch {
      // Fall through: a truncated array is still worth reading line by line.
    }
  }
  const out: Entry[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim().replace(/,$/, '');
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as Entry);
    } catch {
      // A half-written line while the tool is still running.
    }
  }
  return out;
}

/** The entry's text, across the field names the tool has used for it. */
function textOf(entry: Entry): string | null {
  const direct = str(entry.message) ?? str(entry.text) ?? str(entry.content);
  if (direct) return direct;
  const parts = (entry.parts ?? (entry.content as Entry | undefined)?.parts) as unknown;
  if (!Array.isArray(parts)) return null;
  const joined = parts
    .map((p) => (typeof p === 'string' ? p : str((p as Entry)?.text)))
    .filter((p): p is string => !!p)
    .join('\n');
  return joined === '' ? null : joined;
}

/** 'user' vs the model, across the role names the tool has used. */
function roleOf(entry: Entry): 'user' | 'model' | null {
  const raw = (str(entry.type) ?? str(entry.role) ?? str(entry.sender) ?? '').toLowerCase();
  if (raw === 'user' || raw === 'human') return 'user';
  if (raw === 'gemini' || raw === 'model' || raw === 'assistant') return 'model';
  return null;
}

/** A tool call, wherever the entry hung it. */
function toolCallsOf(entry: Entry): Entry[] {
  const found: Entry[] = [];
  for (const key of ['toolCalls', 'tool_calls', 'functionCalls', 'tools']) {
    const value = entry[key];
    if (Array.isArray(value)) found.push(...value.filter((v): v is Entry => !!v && typeof v === 'object'));
  }
  if (entry.toolCall && typeof entry.toolCall === 'object') found.push(entry.toolCall as Entry);
  if (str(entry.type) === 'tool' || str(entry.type) === 'tool_call') found.push(entry);
  return found;
}

function fileOf(call: Entry): string | null {
  const args = (call.args ?? call.arguments ?? call.input ?? {}) as Entry;
  return str(args.file_path) ?? str(args.absolute_path) ?? str(args.path) ?? str(args.filePath) ?? null;
}

export function parseGeminiCliSession(text: string, fallbackSessionId?: string): ParseResult {
  const entries = entriesOf(text);
  if (entries.length === 0) return { ok: false, reason: 'the log had no readable entries' };

  const session: ParsedSession = {
    agent: 'gemini-cli',
    sessionId: fallbackSessionId ?? '',
    cwd: null,
    startedAt: null,
    endedAt: null,
    intent: null,
    files: [],
    tools: {},
    costUsd: null,
    sawError: false,
    assistantTurns: 0,
  };
  const files = new Set<string>();

  for (const entry of entries) {
    if (!session.sessionId) session.sessionId = str(entry.sessionId) ?? str(entry.session_id) ?? '';
    session.cwd ??= str(entry.cwd) ?? str(entry.workspace) ?? str(entry.projectRoot);

    const at = whenOf(entry.timestamp) ?? whenOf(entry.time) ?? whenOf(entry.createdAt);
    if (at) {
      session.startedAt ??= at;
      session.endedAt = at;
    }

    const role = roleOf(entry);
    const body = textOf(entry);
    if (role === 'user' && body && !session.intent) session.intent = boundIntent(body);
    if (role === 'model') session.assistantTurns += 1;
    if (entry.error !== undefined && entry.error !== null) session.sawError = true;

    for (const call of toolCallsOf(entry)) {
      const name = str(call.name) ?? str(call.tool) ?? str(call.toolName);
      if (!name) continue;
      addTool(session.tools, name);
      const file = fileOf(call);
      if (file) addFile(files, relativeTo(session.cwd, file));
      if (call.error !== undefined && call.error !== null) session.sawError = true;
    }
  }

  // Never invented. Without the tool's own id there is no session to report,
  // and filing one under a made-up id would poison the record it feeds.
  if (!session.sessionId) return { ok: false, reason: 'the log never said which session it was' };
  session.files = [...files];
  return { ok: true, session };
}
