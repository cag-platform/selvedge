/**
 * Dependency-free connector installed in a temporary workspace. It opens one
 * outbound WebSocket to Selvedge and forwards relay requests only to the
 * explicitly configured loopback port.
 *
 * The connector credential is uploaded in a separate, short-lived config file
 * and unlinked immediately after startup. It is never included in an agent
 * prompt, command line, URL, or log message.
 */
export const PREVIEW_CONNECTOR_FILENAME = 'selvedge-preview-connector.mjs';

export function previewConnectorSource(): string {
  return String.raw`import { readFileSync, unlinkSync } from 'node:fs';

const configPath = process.argv[2];
if (!configPath) throw new Error('connector config path is required');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
unlinkSync(configPath);

if (!/^wss:\/\//.test(config.url)) throw new Error('relay must use wss');
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('invalid preview port');

let stopped = false;
let retryMs = 250;
let retryTimer = null;

function scheduleRetry() {
  if (stopped || retryTimer) return;
  const delay = retryMs;
  retryMs = Math.min(retryMs * 2, 5000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function safeHeaders(headers) {
  const blocked = new Set(['authorization', 'cookie', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);
  const result = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!blocked.has(lower)) result[lower] = value;
  }
  return result;
}

async function forward(socket, message) {
  try {
    const rawPath = typeof message.path === 'string' && message.path.startsWith('/') ? message.path : '/';
    const target = new URL(rawPath, 'http://127.0.0.1:' + config.port);
    if (target.hostname !== '127.0.0.1' || Number(target.port) !== config.port) throw new Error('invalid relay target');
    const response = await fetch(target, {
      method: message.method,
      headers: safeHeaders(Object.entries(message.headers || {})),
      body: message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64') : undefined,
      redirect: 'manual',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    socket.send(JSON.stringify({
      type: 'response', id: message.id, status: response.status,
      headers: safeHeaders(response.headers), bodyBase64: bytes.length ? bytes.toString('base64') : null,
    }));
  } catch {
    socket.send(JSON.stringify({ type: 'response', id: message.id, status: 502,
      headers: { 'content-type': 'text/plain' }, bodyBase64: Buffer.from('Workspace preview unavailable').toString('base64') }));
  }
}

function connect() {
  if (stopped) return;
  const socket = new WebSocket(config.url, ['selvedge-preview', config.token]);
  socket.addEventListener('open', () => { retryMs = 250; });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.type === 'request') void forward(socket, message);
      else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', at: message.at }));
    } catch { /* malformed relay messages are ignored */ }
  });
  socket.addEventListener('close', scheduleRetry);
  // Node does not guarantee that a failed CONNECTING socket emits close after
  // error. Schedule the same guarded retry from both events; never call
  // socket.close() here, because that recursively emits error on Node 22.
  socket.addEventListener('error', scheduleRetry);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; process.exit(0); });
connect();
`;
}
