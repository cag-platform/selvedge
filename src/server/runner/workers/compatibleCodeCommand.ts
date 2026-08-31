import { MAX_TOOL_EVENTS, type ToolEvent } from '../../../shared/types/toolEvent.js';
import { agentRules, shellQuote, WORKDIR } from './claudeCommand.js';

const TOOLS = '/tmp/selvedge-agent-tools';
const HOME = '/tmp/selvedge-worker';
const transport = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export type CompatibleWorker = 'kimi-code' | 'grok-build';

export function compatibleInstallCommand(worker: CompatibleWorker): string {
  const install = worker === 'kimi-code'
    ? `kimi --version >/dev/null 2>&1 || npm install -g --prefix ${TOOLS} @moonshot-ai/kimi-code`
    : `grok --version >/dev/null 2>&1 || { curl -fsSL https://x.ai/cli/install.sh | bash; mkdir -p ${TOOLS}/bin; cp "$(command -v grok)" ${TOOLS}/bin/grok; }`;
  return `mkdir -p ${TOOLS}/bin ${HOME} && chmod 0777 ${HOME} && export PATH="${TOOLS}/bin:$HOME/.local/bin:$PATH" && (${install}) && chmod -R a+rX ${TOOLS} && chmod -R a+rwX ${WORKDIR}`;
}

export function compatibleCodeCommand(worker: CompatibleWorker, prompt: string, opts: { resumeSessionId?: string | null; mode: 'build' | 'plan' }): string {
  const promptFile = `/tmp/selvedge-${worker}-prompt`;
  const fullPrompt = `${agentRules(opts.mode)}\n\n---\n\n${prompt}`;
  const args = worker === 'kimi-code'
    ? ['kimi', '-p', `"$(cat ${promptFile})"`, '--output-format', 'stream-json']
    : ['grok', '-p', `"$(cat ${promptFile})"`, '--output-format', 'streaming-json', '--always-approve', '--no-auto-update'];
  if (opts.resumeSessionId) args.push(worker === 'kimi-code' ? '--session' : '--session-id', shellQuote(opts.resumeSessionId));
  // Credentials and Kimi's documented KIMI_MODEL_* compatibility channel are
  // injected command-scoped by builderAuth; no secret is rendered here.
  const inner = `export PATH="$HOME/.local/bin:${TOOLS}/bin:$PATH" && cd ${WORKDIR} && ${args.join(' ')}`;
  return [`printf %s ${transport(fullPrompt)} | base64 -d > ${promptFile}`, `chmod 0444 ${promptFile}`, `runuser -u nobody --preserve-environment -- env HOME=${HOME} sh -lc ${shellQuote(inner)}`, 'status=$?', `rm -f ${promptFile}`, 'exit $status'].join('; ');
}

function objects(log: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of log.split('\n')) { try { const value = JSON.parse(line); if (value && typeof value === 'object') found.push(value as Record<string, unknown>); } catch { /* stderr */ } }
  return found;
}

function stringAt(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) if (typeof object[key] === 'string' && object[key]) return object[key] as string;
  for (const nested of ['message', 'content', 'data', 'result']) { const hit = stringAt(object[nested], keys); if (hit) return hit; }
  return null;
}

export function parseCompatible(log: string) {
  const rows = objects(log);
  const sessionId = [...rows].reverse().map((row) => stringAt(row, ['session_id', 'sessionId'])).find(Boolean) ?? null;
  const text = rows.map((row) => stringAt(row, ['text', 'output', 'result'])).filter(Boolean).join('\n').trim();
  const tools: ToolEvent[] = rows.map((row) => stringAt(row, ['tool_name', 'tool', 'name', 'command'])).filter((detail): detail is string => !!detail).slice(0, MAX_TOOL_EVENTS).map((detail, index) => ({ id: `${workerEventId(detail)}-${index}`, name: detail.split(/\s|:/, 1)[0] || 'tool', detail }));
  return { sessionId, text, tools, truncated: tools.length >= MAX_TOOL_EVENTS };
}

function workerEventId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return `event-${Math.abs(hash)}`;
}
