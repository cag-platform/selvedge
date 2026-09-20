import { MAX_TOOL_EVENTS, type ToolEvent } from '../../../shared/types/toolEvent.js';
import { agentRules, shellQuote, WORKDIR } from './claudeCommand.js';

/**
 * GEMINI CLI AS A BUILDER — the same shape as every other worker: an install
 * command, a turn command, and parsers for what it did, what it said, and what
 * it cost. Auth is a GEMINI_API_KEY injected command-scoped by builderAuth
 * (Google's OAuth/subscription tiers are licensed to Google's own tooling, so
 * the key is the only path offered).
 *
 * OUTPUT is `--output-format stream-json`: newline-delimited events typed
 * init / message / tool_use / tool_result / error / result, with the final
 * `result` event carrying aggregated token stats. The parsers read those
 * types but treat every FIELD defensively, the way parseCompatible does —
 * this CLI moves fast, and a renamed key must degrade to "cost unknown" or a
 * blank activity feed, never a crashed turn.
 *
 * SESSIONS ARE STATELESS FOR NOW, deliberately. Headless output does not
 * reliably carry a session id to resume (google-gemini/gemini-cli#14435), so
 * every turn ships the full handoff context in the prompt — which Selvedge
 * composes anyway — and `sessionId` stays null. When upstream lands the id,
 * resume is `opts.resumeSessionId` plumbing like Claude's, not a redesign.
 */

const TOOLS = '/tmp/selvedge-agent-tools';
const HOME = '/tmp/selvedge-worker';
const transport = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export function geminiModel(): string {
  return process.env.GEMINI_BUILD_MODEL ?? 'gemini-2.5-pro';
}

export function geminiInstallCommand(): string {
  return `mkdir -p ${TOOLS}/bin ${HOME} && chmod 0777 ${HOME} && export PATH="${TOOLS}/bin:$HOME/.local/bin:$PATH" && (gemini --version >/dev/null 2>&1 || npm install -g --prefix ${TOOLS} @google/gemini-cli) && chmod -R a+rX ${TOOLS} && chmod -R a+rwX ${WORKDIR}`;
}

export function geminiCommand(prompt: string, opts: { model?: string | null; mode: 'build' | 'plan' }): string {
  const promptFile = '/tmp/selvedge-gemini-prompt';
  const fullPrompt = `${agentRules(opts.mode)}\n\n---\n\n${prompt}`;
  // --yolo in both modes, like Grok's --always-approve: plan-mode discipline
  // lives in agentRules, and a builder that stops mid-sandbox to ask a
  // question nobody can see is a hung turn, not a safe one.
  const args = ['gemini', '-p', `"$(cat ${promptFile})"`, '--output-format', 'stream-json', '--yolo', '--model', shellQuote(opts.model ?? geminiModel())];
  const inner = `export PATH="$HOME/.local/bin:${TOOLS}/bin:$PATH" && cd ${WORKDIR} && ${args.join(' ')}`;
  return [`printf %s ${transport(fullPrompt)} | base64 -d > ${promptFile}`, `chmod 0444 ${promptFile}`, `runuser -u nobody --preserve-environment -- env HOME=${HOME} sh -lc ${shellQuote(inner)}`, 'status=$?', `rm -f ${promptFile}`, 'exit $status'].join('; ');
}

type Row = Record<string, unknown>;

function rows(log: string): Row[] {
  const found: Row[] = [];
  for (const line of log.split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') found.push(value as Row);
    } catch { /* stderr and partial lines */ }
  }
  return found;
}

function stringAt(value: unknown, keys: string[], depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const object = value as Row;
  for (const key of keys) if (typeof object[key] === 'string' && object[key]) return object[key] as string;
  for (const nested of Object.values(object)) {
    if (Array.isArray(nested)) {
      for (const item of nested) { const hit = stringAt(item, keys, depth + 1); if (hit) return hit; }
    } else if (nested && typeof nested === 'object') {
      const hit = stringAt(nested, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Sum every numeric field with one of these names, anywhere in the object — per-model breakdowns included. */
function sumNumbers(value: unknown, keys: string[], depth = 0): number | null {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  let total: number | null = null;
  const object = value as Row;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) total = (total ?? 0) + candidate;
  }
  for (const nested of Object.values(object)) {
    const hit = sumNumbers(nested, keys, depth + 1);
    if (hit !== null) total = (total ?? 0) + hit;
  }
  return total;
}

export type GeminiResult = {
  sessionId: string | null;
  isError: boolean;
  tokensIn: number;
  tokensOut: number;
  usageReported: boolean;
};

export function parseGeminiResult(log: string): GeminiResult {
  const all = rows(log);
  const result = [...all].reverse().find((row) => row.type === 'result') ?? null;
  const init = all.find((row) => row.type === 'init') ?? null;
  const sessionId = stringAt(init ?? {}, ['session_id', 'sessionId']) ?? stringAt(result ?? {}, ['session_id', 'sessionId']);
  // No result event means the CLI died before finishing — an error whatever
  // the exit code said, because a turn with no outcome is not a success.
  const isError = !result || result.error != null || stringAt(result, ['status']) === 'error' || result.is_error === true;
  const tokensIn = result ? sumNumbers(result, ['input_tokens', 'prompt_tokens', 'promptTokenCount', 'input_token_count']) : null;
  const tokensOut = result ? sumNumbers(result, ['output_tokens', 'completion_tokens', 'candidatesTokenCount', 'output_token_count']) : null;
  return {
    sessionId: sessionId ?? null,
    isError,
    tokensIn: tokensIn ?? 0,
    tokensOut: tokensOut ?? 0,
    // Both or nothing: half a usage report priced as a whole one undercounts.
    usageReported: tokensIn !== null && tokensOut !== null,
  };
}

export function parseGeminiText(log: string): string {
  const all = rows(log);
  const fromMessages = all
    .filter((row) => row.type === 'message' && stringAt(row, ['role']) !== 'user')
    .map((row) => stringAt(row, ['text', 'content', 'response']))
    .filter(Boolean)
    .join('');
  if (fromMessages.trim()) return fromMessages.trim();
  const result = [...all].reverse().find((row) => row.type === 'result');
  return (result && stringAt(result, ['response', 'text', 'output']))?.trim() ?? '';
}

export function parseGeminiEvents(log: string): { tools: ToolEvent[]; truncated: boolean } {
  const tools: ToolEvent[] = [];
  for (const row of rows(log)) {
    if (row.type !== 'tool_use') continue;
    if (tools.length >= MAX_TOOL_EVENTS) return { tools, truncated: true };
    const name = stringAt(row, ['name', 'tool_name', 'tool']) ?? 'tool';
    const detail = stringAt(row, ['command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description']) ?? name;
    const id = stringAt(row, ['id', 'call_id', 'tool_use_id']) ?? `gemini-${tools.length}`;
    tools.push({ id, name, detail });
  }
  return { tools, truncated: false };
}
