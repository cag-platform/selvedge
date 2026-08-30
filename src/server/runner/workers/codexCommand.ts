import { MAX_TOOL_EVENTS, MAX_INPUT_CHARS, MAX_NOTE_CHARS, type ToolEvent } from '../../../shared/types/toolEvent.js';
import { WORKDIR, PATH_PREFIX, shellQuote, agentRules } from './claudeCommand.js';

/**
 * The second builder: OpenAI's Codex CLI, running in the SAME workspace as Claude
 * Code, on the same checkout, under the same rules.
 *
 * Why the same sandbox rather than a second one: the whole point of switching
 * mid-thread is that the work in progress carries over. A second sandbox would
 * mean a second checkout, and the staged changes the owner is looking at would
 * be in the other room.
 *
 * TWO REAL DIFFERENCES FROM CLAUDE CODE, both contained in this file:
 *
 *  1. There is no --append-system-prompt. The standing rules (who this is for,
 *     no terminal, never hand over a checklist) therefore ride at the head of
 *     the PROMPT. They must not be written into the repo as an AGENTS.md for
 *     the same reason a CLAUDE.md was refused: `git add -A` would commit our
 *     rules into the customer's code, and `git status` treats them as work
 *     ready to ship.
 *  2. The CLI reports tokens rather than dollars, so a turn's cost is computed
 *     from its token counts at the model's published rate (llm/pricing.ts)
 *     instead of read off the stream. When the stream reports no usage at all,
 *     the cost is recorded as zero AND the caller is told the count was
 *     missing — an unreported turn must never look like a free one.
 *
 * HONESTY ABOUT THIS FILE: the Codex CLI's JSON event stream is undocumented
 * and has changed shape between versions. Every parser here is written to be
 * tolerant of the shapes seen in the wild (`item.completed` envelopes, older
 * `msg` envelopes, bare events) and to return NOTHING rather than a guess when
 * it recognizes none of them. It has not been run against the live CLI from
 * this environment — it is listed as unverified in STATUS.md, and the failure
 * mode is deliberately a turn that reports "I couldn't read what Codex did"
 * rather than a turn that claims success it cannot see.
 */

/** What Codex runs as by default here; overridable per deployment. */
export function codexModel(): string {
  return process.env.CODEX_MODEL ?? 'gpt-5.6-terra';
}

/** Install the CLI if the image doesn't ship it. Idempotent, safe to run every turn. */
export function codexInstallCommand(): string {
  return `${PATH_PREFIX} codex --version >/dev/null 2>&1 || npm install -g --prefix "$HOME/.npm-global" @openai/codex`;
}

export function codexCommand(
  prompt: string,
  opts: { apiKey?: string; model?: string; resumeSessionId?: string | null; mode?: 'build' | 'plan' },
): string {
  const mode = opts.mode ?? 'build';
  const promptFile = '/tmp/selvedge-codex-prompt';
  const transportedPrompt = Buffer.from(`${agentRules(mode)}\n\n---\n\n${prompt}`, 'utf8').toString('base64');
  const args = [
    'codex',
    'exec',
    ...(opts.resumeSessionId ? ['resume', shellQuote(opts.resumeSessionId)] : []),
    '--json',
    '--model',
    shellQuote(opts.model ?? codexModel()),
    // Plan mode reads and reasons but changes nothing — the same promise the
    // "think it first" checkbox makes on the Claude side.
    ...(mode === 'plan' ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']),
    // A lone dash makes Codex read the prompt from stdin. The prompt must
    // never be part of a shell command: this command is itself launched by a
    // detached shell, and nested quote escaping once caused lines of the
    // owner's prompt and Selvedge's rules to be executed as commands.
    '-',
  ];
  // OPENAI_API_KEY is injected command-scoped by the Workspace Runtime. Putting
  // it here would expose it to the hosted-shell model prompt and flight record.
  return [
    `printf %s ${transportedPrompt} | base64 -d > ${promptFile}`,
    `chmod 0400 ${promptFile}`,
    `${PATH_PREFIX} cd ${WORKDIR} && ${args.join(' ')} < ${promptFile}`,
    'status=$?',
    `rm -f ${promptFile}`,
    'exit $status',
  ].join('; ');
}

export type CodexResult = {
  sessionId: string | null;
  isError: boolean;
  tokensIn: number;
  tokensOut: number;
  /** False when the stream carried no usage at all — the caller must not read zero cost as a free turn. */
  usageReported: boolean;
};

type Json = Record<string, unknown>;

function lines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as Json);
    } catch {
      // A half-written line while the log is still being tailed. Skip it.
    }
  }
  return out;
}

/** Look through the envelope shapes this CLI has used, and return the inner payloads. */
function payloads(event: Json): Json[] {
  const out: Json[] = [event];
  for (const key of ['msg', 'item', 'data']) {
    const nested = event[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) out.push(nested as Json);
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The final state of a Codex turn: its session (for resuming), whether it failed, and what it used. */
export function parseCodexResult(stdout: string): CodexResult {
  let sessionId: string | null = null;
  let isError = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let usageReported = false;
  let sawCompletion = false;

  for (const event of lines(stdout)) {
    for (const payload of payloads(event)) {
      const type = str(payload.type) ?? '';
      sessionId =
        str(payload.session_id) ??
        str(payload.thread_id) ??
        (type.startsWith('session') || type.startsWith('thread') ? str(payload.id) : null) ??
        sessionId;

      if (type === 'error' || type.endsWith('.failed') || payload.is_error === true) isError = true;
      if (type.endsWith('.completed') && (type.startsWith('turn') || type.startsWith('thread'))) sawCompletion = true;

      const usage = (payload.usage ?? payload.total_token_usage ?? (payload.info as Json | undefined)?.total_token_usage) as Json | undefined;
      if (usage && typeof usage === 'object') {
        const input = num(usage.input_tokens) ?? num(usage.prompt_tokens);
        const output = num(usage.output_tokens) ?? num(usage.completion_tokens);
        // Usage is reported cumulatively per turn; the largest reading wins so
        // an early partial line can't undercount the finished turn.
        if (input !== null) tokensIn = Math.max(tokensIn, input);
        if (output !== null) tokensOut = Math.max(tokensOut, output);
        if (input !== null || output !== null) usageReported = true;
      }
    }
  }

  // No completion event and no error event means we never saw the turn finish —
  // treated as a failure, because "I didn't see it finish" must never read as
  // "it worked".
  if (!sawCompletion && !isError) isError = true;
  return { sessionId, isError, tokensIn, tokensOut, usageReported };
}

/** The agent's own words — what the thread shows as the reply. */
export function parseCodexText(stdout: string): string {
  const parts: string[] = [];
  for (const event of lines(stdout)) {
    for (const payload of payloads(event)) {
      const type = str(payload.type) ?? '';
      if (type !== 'agent_message' && type !== 'assistant_message') continue;
      const text = str(payload.text) ?? str(payload.message);
      if (text) parts.push(text.trim());
    }
  }
  return parts.join('\n\n');
}

const cap = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const rel = (p: string) => p.replace(/^\/workspace\/app\//, '');

/**
 * The flight record for a Codex turn, in the same ToolEvent shape the recorder
 * already stores — so the live feed, the full record and the handoff all read a
 * Codex turn exactly as they read a Claude one.
 */
export function parseCodexEvents(stdout: string): { tools: ToolEvent[]; truncated: boolean } {
  const tools: ToolEvent[] = [];
  let truncated = false;
  let index = 0;

  const push = (tool: ToolEvent) => {
    if (tools.length >= MAX_TOOL_EVENTS) {
      truncated = true;
      return;
    }
    tools.push(tool);
  };

  for (const event of lines(stdout)) {
    for (const payload of payloads(event)) {
      const type = str(payload.type) ?? '';

      if (type === 'command_execution' || type === 'exec_command_end' || type === 'exec_command_begin') {
        const raw = payload.command;
        const command = Array.isArray(raw) ? raw.map(String).join(' ') : (str(raw) ?? '');
        if (!command) continue;
        // begin/end pairs describe one command; the end carries the outcome.
        const exit = num(payload.exit_code);
        const existing = tools.find((t) => t.name === 'Bash' && t.input?.command === cap(command, MAX_INPUT_CHARS) && t.ok === undefined);
        if (existing && exit !== null) {
          existing.ok = exit === 0;
          if (exit !== 0) {
            const output = str(payload.aggregated_output) ?? str(payload.stdout) ?? str(payload.output);
            if (output) existing.note = cap(output.trim(), MAX_NOTE_CHARS);
          }
          continue;
        }
        if (existing) continue;
        push({
          id: `codex_${index++}`,
          name: 'Bash',
          detail: `Running: ${cap(command, 70)}`,
          input: { command: cap(command, MAX_INPUT_CHARS) },
          ...(exit === null ? {} : { ok: exit === 0 }),
        });
        continue;
      }

      if (type === 'file_change' || type === 'patch_apply_end' || type === 'patch_apply_begin') {
        const changes = payload.changes ?? payload.files;
        const paths = Array.isArray(changes)
          ? changes.map((c) => (typeof c === 'string' ? c : (str((c as Json).path) ?? str((c as Json).file) ?? ''))).filter(Boolean)
          : [];
        const success = payload.success;
        for (const path of paths) {
          push({
            id: `codex_${index++}`,
            name: 'Edit',
            detail: `Editing ${rel(path)}`,
            input: { file_path: cap(path, MAX_INPUT_CHARS) },
            ...(typeof success === 'boolean' ? { ok: success } : {}),
          });
        }
        continue;
      }

      if (type === 'reasoning' || type === 'agent_reasoning') {
        const text = str(payload.text) ?? str(payload.summary);
        if (text) push({ id: `codex_${index++}`, name: 'Thinking', detail: cap(text.replace(/\s+/g, ' ').trim(), 90) });
      }
    }
  }

  return { tools, truncated };
}

export function parseCodexActivity(stdout: string): string[] {
  return parseCodexEvents(stdout).tools.map((t) => t.detail);
}
