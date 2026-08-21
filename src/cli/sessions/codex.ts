import { addFile, addTool, boundIntent, jsonLines, relativeTo, str, whenOf, type ParseResult, type ParsedSession } from './parse.js';

/**
 * Codex's rollout log: newline-delimited JSON under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *
 * Its entries wrap almost everything in `payload`, and the shapes have moved
 * between versions — session_meta vs session.created, function_call vs
 * local_shell_call, `arguments` as a JSON string vs an object. This unwraps one
 * level, looks for what it recognises anywhere in there, and refuses to guess
 * at the rest: a log it cannot find a session id in is reported as unreadable
 * rather than filed under a made-up one.
 */

function payloads(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  const out = [entry];
  for (const key of ['payload', 'msg', 'item', 'info']) {
    const nested = entry[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) out.push(nested as Record<string, unknown>);
  }
  return out;
}

/** Codex writes user text as content blocks with an input_text type. */
function userText(payload: Record<string, unknown>): string | null {
  if (str(payload.role) !== 'user') return null;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    const text = str(b?.text);
    if (text && (b?.type === 'input_text' || b?.type === 'text' || b?.type === undefined)) parts.push(text);
  }
  return parts.length ? parts.join('\n') : null;
}

/** A shell call's arguments, whether they arrived as an object or a JSON string. */
function argsOf(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments ?? payload.args ?? payload.input;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Arguments we can't read tell us nothing; the call itself still counts.
    }
  }
  return {};
}

/** Paths out of an apply_patch-style call, which is how Codex edits files. */
function patchedFiles(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  const changes = args.changes ?? args.files;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    found.push(...Object.keys(changes as Record<string, unknown>));
  } else if (Array.isArray(changes)) {
    for (const change of changes) {
      const path = typeof change === 'string' ? change : str((change as Record<string, unknown>)?.path);
      if (path) found.push(path);
    }
  }
  const single = str(args.path) ?? str(args.file_path);
  if (single) found.push(single);
  // The classic form: a patch body with *** Update File: lines in it. Only the
  // names are read; the patch itself is dropped where it lies.
  const patch = str(args.patch) ?? str(args.input);
  if (patch) {
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const name = match[1]?.trim();
      if (name) found.push(name);
    }
  }
  return found;
}

export function parseCodexSession(text: string, fallbackSessionId?: string): ParseResult {
  const entries = jsonLines(text);
  if (entries.length === 0) return { ok: false, reason: 'the log had no readable entries' };

  const session: ParsedSession = {
    agent: 'codex',
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
    const at = whenOf(entry.timestamp);
    if (at) {
      session.startedAt ??= at;
      session.endedAt = at;
    }

    // The envelope carries the kind and the payload carries the data, so a
    // payload with no type of its own inherits its envelope's — which is how
    // `{type:'session_meta', payload:{id:…}}` gets read at all.
    const envelope = str(entry.type) ?? '';
    for (const payload of payloads(entry)) {
      const type = str(payload.type) ?? envelope;
      if (!session.sessionId) {
        const id = str(payload.session_id) ?? str(payload.thread_id) ?? (type.startsWith('session') || type.startsWith('thread') ? str(payload.id) : null);
        if (id) session.sessionId = id;
      }
      session.cwd ??= str(payload.cwd) ?? str(payload.workdir) ?? str(payload.working_directory);

      const asked = userText(payload);
      if (asked && !session.intent) session.intent = boundIntent(asked);

      if (type === 'agent_message' || type === 'assistant_message') session.assistantTurns += 1;
      if (type === 'error' || type.endsWith('.failed') || payload.is_error === true) session.sawError = true;

      if (type === 'function_call' || type === 'local_shell_call' || type === 'custom_tool_call' || type === 'command_execution') {
        const name = str(payload.name) ?? 'shell';
        addTool(session.tools, name);
        for (const file of patchedFiles(argsOf(payload))) addFile(files, relativeTo(session.cwd, file));
      }
      if (type === 'file_change' || type === 'patch_apply_begin') {
        addTool(session.tools, 'apply_patch');
        for (const file of patchedFiles(payload)) addFile(files, relativeTo(session.cwd, file));
      }
    }
  }

  if (!session.sessionId) return { ok: false, reason: 'the log never said which session it was' };
  session.files = [...files];
  return { ok: true, session };
}
