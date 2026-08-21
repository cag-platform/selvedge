import { addFile, addTool, boundIntent, jsonLines, relativeTo, str, whenOf, type ParseResult, type ParsedSession } from './parse.js';
import { entriesOf } from './geminiCli.js';

/**
 * Cursor's agent session log.
 *
 * UNVERIFIED, and more so than the Gemini reader. Cursor's IDE chat lives in a
 * SQLite workspace database, which this companion deliberately does not open:
 * reading another editor's internal state file is not something to do on
 * somebody's laptop on a guess. What this reads is the newline-delimited or
 * array JSON its agent CLI writes under a session root, and only when that root
 * is configured or present.
 *
 * Written against the shape as understood. Not proved against a log this
 * codebase has seen, and the honest consequence is designed in rather than
 * apologised for: anything it can't read comes back `unreadable` with a reason
 * and is REPORTED, so an owner who used Cursor all Thursday finds out on Friday
 * that Selvedge couldn't read it — never that nothing happened.
 */

type Entry = Record<string, unknown>;

function textOf(entry: Entry): string | null {
  const direct = str(entry.text) ?? str(entry.message) ?? str(entry.prompt);
  if (direct) return direct;
  const content = entry.content;
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((c) => (typeof c === 'string' ? c : str((c as Entry)?.text)))
    .filter((c): c is string => !!c)
    .join('\n');
  return joined === '' ? null : joined;
}

function roleOf(entry: Entry): 'user' | 'assistant' | null {
  const raw = (str(entry.role) ?? str(entry.type) ?? str(entry.sender) ?? '').toLowerCase();
  if (raw === 'user' || raw === 'human' || raw === 'user_message') return 'user';
  if (raw === 'assistant' || raw === 'agent' || raw === 'assistant_message') return 'assistant';
  return null;
}

function toolCallsOf(entry: Entry): Entry[] {
  const found: Entry[] = [];
  for (const key of ['toolCalls', 'tool_calls', 'tools']) {
    const value = entry[key];
    if (Array.isArray(value)) found.push(...value.filter((v): v is Entry => !!v && typeof v === 'object'));
  }
  const type = (str(entry.type) ?? '').toLowerCase();
  if (type === 'tool_call' || type === 'tool_use' || type === 'tool') found.push(entry);
  return found;
}

function fileOf(call: Entry): string | null {
  const args = (call.args ?? call.arguments ?? call.input ?? call.params ?? {}) as Entry;
  return str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? str(args.target_file) ?? str(args.uri) ?? null;
}

export function parseCursorSession(text: string, fallbackSessionId?: string): ParseResult {
  // Cursor has written both containers; jsonLines handles the strict JSONL
  // case and entriesOf covers a whole-file JSON array.
  const lines = jsonLines(text);
  const entries: Entry[] = lines.length > 0 ? lines : entriesOf(text);
  if (entries.length === 0) return { ok: false, reason: 'the log had no readable entries' };

  const session: ParsedSession = {
    agent: 'cursor',
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
    if (!session.sessionId) {
      session.sessionId = str(entry.sessionId) ?? str(entry.session_id) ?? str(entry.composerId) ?? str(entry.threadId) ?? '';
    }
    session.cwd ??= str(entry.cwd) ?? str(entry.workspace) ?? str(entry.workspacePath) ?? str(entry.rootPath);

    const at = whenOf(entry.timestamp) ?? whenOf(entry.createdAt) ?? whenOf(entry.time);
    if (at) {
      session.startedAt ??= at;
      session.endedAt = at;
    }

    const role = roleOf(entry);
    const body = textOf(entry);
    if (role === 'user' && body && !session.intent) session.intent = boundIntent(body);
    if (role === 'assistant') session.assistantTurns += 1;
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

  if (!session.sessionId) return { ok: false, reason: 'the log never said which session it was' };
  session.files = [...files];
  return { ok: true, session };
}
