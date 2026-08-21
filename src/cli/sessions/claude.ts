import { addFile, addTool, boundIntent, jsonLines, relativeTo, str, whenOf, type ParseResult, type ParsedSession } from './parse.js';

/**
 * Claude Code's session log: newline-delimited JSON under
 * ~/.claude/projects/<encoded-path>/<session-id>.jsonl, one entry per turn.
 *
 * The shapes this reads, all of them optional and all of them checked:
 *   sessionId / cwd / timestamp   — on most entries; the first one wins
 *   type: "user"                  — the ask. The FIRST real one is the intent.
 *   type: "assistant"             — content blocks, of which tool_use is what
 *                                   we count; the prose is read and dropped.
 *   costUSD / message.usage       — what the turn cost, when the tool says so.
 *
 * Entries the CLI writes for itself (command echoes, caveats, meta) are skipped
 * when looking for the intent — otherwise every session's stated purpose would
 * be "<command-name>/clear".
 */

const META_PREFIXES = ['<command-name>', '<local-command', '<user-memory', 'Caveat:', '<system-reminder>'];

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.length ? parts.join('\n') : null;
}

function isMeta(text: string): boolean {
  const trimmed = text.trimStart();
  return META_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** The file a tool worked on, as the tool named it. */
function fileOf(input: Record<string, unknown>): string | null {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
}

export function parseClaudeSession(text: string, fallbackSessionId?: string): ParseResult {
  const entries = jsonLines(text);
  if (entries.length === 0) return { ok: false, reason: 'the log had no readable entries' };

  const session: ParsedSession = {
    agent: 'claude-code',
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
  let cost = 0;
  let sawCost = false;

  for (const entry of entries) {
    session.sessionId ||= str(entry.sessionId) ?? '';
    session.cwd ??= str(entry.cwd);
    const at = whenOf(entry.timestamp);
    if (at) {
      session.startedAt ??= at;
      session.endedAt = at;
    }

    const type = str(entry.type);
    const message = entry.message as Record<string, unknown> | undefined;

    if (type === 'user' && entry.isMeta !== true) {
      const text = textOf(message?.content);
      if (text && !isMeta(text) && !session.intent) session.intent = boundIntent(text);
    }

    if (type === 'assistant') {
      session.assistantTurns += 1;
      const blocks = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue;
        const name = str(block.name) ?? 'tool';
        addTool(session.tools, name);
        const file = fileOf((block.input ?? {}) as Record<string, unknown>);
        if (file) addFile(files, relativeTo(session.cwd, file));
      }
      if (typeof entry.costUSD === 'number' && Number.isFinite(entry.costUSD)) {
        cost += entry.costUSD;
        sawCost = true;
      }
    }

    if (type === 'error' || entry.isApiErrorMessage === true) session.sawError = true;
  }

  if (!session.sessionId) return { ok: false, reason: 'the log never said which session it was' };
  session.files = [...files];
  session.costUsd = sawCost ? Number(cost.toFixed(4)) : null;
  return { ok: true, session };
}
