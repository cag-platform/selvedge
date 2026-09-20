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

/**
 * Response headers a previewed app is ALLOWED to set on the product origin.
 *
 * The relay serves customer/agent-written app output back under a
 * `/workspace-preview/...` path on Selvedge's own origin. Forwarding its
 * headers verbatim let that app assert anything — `Access-Control-Allow-Origin: *`,
 * a permissive `Content-Security-Policy`, an `X-Frame-Options` of its choosing —
 * on the product origin. Only these presentational headers are useful to a
 * preview and safe to echo; everything else the app tries to set is dropped and
 * replaced by our own forced security headers (see `previewSecurityHeaders`).
 */
const PREVIEW_RESPONSE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'content-language',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'age',
  'vary',
  'location',
  'accept-ranges',
  'content-range',
]);

export function allowlistPreviewResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (PREVIEW_RESPONSE_HEADER_ALLOWLIST.has(name.toLowerCase())) safe[name.toLowerCase()] = value;
  }
  return safe;
}

/**
 * The headers WE force onto every preview response, overriding anything the app
 * sent. `Content-Security-Policy: sandbox ...` is the load-bearing one: applied
 * to a response, it drops that document into a unique opaque origin EVEN when it
 * is served from the product host. So preview scripts cannot read the Clerk
 * cookie, cannot call `/api/*` with the owner's credentials, and cannot touch
 * product-origin storage — the isolation a separate domain would give, enforced
 * by the server, so it holds before any DNS change lands. `allow-scripts` and
 * `allow-forms` keep the previewed app interactive; `allow-same-origin` is
 * deliberately absent, which is what keeps the origin opaque.
 */
export function previewSecurityHeaders(): Record<string, string> {
  return {
    'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
  };
}
