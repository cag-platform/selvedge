/**
 * Dependency-free connector installed in a temporary workspace. It uses
 * authenticated HTTPS long polling because hosted-container allowlists permit
 * ordinary HTTPS while WebSocket upgrades may be blocked.
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

if (!/^https:\/\//.test(config.url)) throw new Error('relay must use https');
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('invalid preview port');

let stopped = false;
let retryMs = 250;

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

async function forward(message) {
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
    return {
      type: 'response', id: message.id, status: response.status,
      headers: safeHeaders(response.headers), bodyBase64: bytes.length ? bytes.toString('base64') : null,
    };
  } catch {
    return { type: 'response', id: message.id, status: 502,
      headers: { 'content-type': 'text/plain' }, bodyBase64: Buffer.from('Workspace preview unavailable').toString('base64') };
  }
}

async function connect() {
  while (!stopped) {
    try {
      const poll = await fetch(config.url, { headers: { authorization: 'Bearer ' + config.token } });
      if (!poll.ok) throw new Error('relay poll failed');
      const envelope = await poll.json();
      const message = envelope.message;
      retryMs = 250;
      if (!message) continue;
      const parsed = JSON.parse(message);
      const response = parsed.type === 'request'
        ? await forward(parsed)
        : parsed.type === 'ping'
          ? { type: 'pong', at: parsed.at }
          : null;
      if (response) {
        const sent = await fetch(config.url, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
          body: JSON.stringify(response),
        });
        if (!sent.ok) throw new Error('relay response failed');
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 5000);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; process.exit(0); });
void connect();
`;
}
