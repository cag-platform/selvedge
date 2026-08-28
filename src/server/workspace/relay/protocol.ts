/** Messages on the outbound workspace ↔ Selvedge Preview Relay connection. */
export type RelayRequest = {
  type: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyBase64: string | null;
};

export type RelayResponse = {
  type: 'response';
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyBase64: string | null;
};

export type RelayReady = { type: 'ready'; previewId: string };
export type RelayPing = { type: 'ping'; at: number };
export type RelayPong = { type: 'pong'; at: number };

export type WorkspaceToRelayMessage = RelayReady | RelayResponse | RelayPong;
export type RelayToWorkspaceMessage = RelayRequest | RelayPing;

/** Headers that must never cross the workspace boundary in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

export function safeRelayHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === 'authorization' || name === 'cookie') continue;
    if (typeof rawValue === 'string') safe[name] = rawValue;
    else if (Array.isArray(rawValue)) safe[name] = rawValue.join(', ');
  }
  return safe;
}
