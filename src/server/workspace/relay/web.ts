import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Router, type Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PreviewRelayBroker, PreviewRelayTimeoutError, PreviewRelayUnavailableError } from './broker.js';
import { safeRelayHeaders } from './protocol.js';
import { PreviewRelaySessions } from './session.js';

const VIEWER_COOKIE = 'selvedge_preview';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function previewPath(previewId: string): string {
  return `/workspace-preview/${encodeURIComponent(previewId)}`;
}

/**
 * Apps commonly emit root-relative asset URLs (for example `/@vite/client`).
 * A path-mounted relay must keep those requests inside the signed preview
 * namespace or the browser will request Selvedge's own SPA instead.
 */
export function rewritePreviewBody(previewId: string, contentType: string | undefined, body: Buffer): Buffer {
  if (!body.length || !contentType) return body;
  const prefix = previewPath(previewId);
  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');
  const isJavaScript = contentType.includes('javascript') || contentType.includes('ecmascript');
  if (!isHtml && !isCss && !isJavaScript) return body;

  let text = body.toString('utf8');
  if (isHtml) {
    text = text.replace(/\b(src|href|action)=(['"])\/(?!\/|workspace-preview\/)/gi, `$1=$2${prefix}/`);
  }
  if (isCss) {
    text = text.replace(/url\(\s*(['"]?)\/(?!\/|workspace-preview\/)/gi, `url($1${prefix}/`);
  }
  if (isJavaScript) {
    text = text.replace(/(['"])\/(?!\/|workspace-preview\/)(?=[@\w.-])/g, `$1${prefix}/`);
  }
  return Buffer.from(text);
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : null;
}

/**
 * Browser-style WebSocket clients cannot set Authorization. The workspace
 * connector therefore sends its short-lived capability as the second
 * subprotocol. The server only negotiates the public protocol name, so the
 * credential is never reflected to the client.
 */
export function connectorCredential(req: IncomingMessage): string | null {
  const authorization = bearer(req);
  if (authorization) return authorization;
  const protocols = req.headers['sec-websocket-protocol']
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  return protocols[0] === 'selvedge-preview' ? protocols[1] ?? null : null;
}

function cookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [rawName, ...rest] = pair.trim().split('=');
    if (rawName === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function bodyOf(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('preview request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export type PreviewRelayWeb = {
  router: Router;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
};

export function createPreviewRelayWeb(tokens: PreviewRelaySessions, broker: PreviewRelayBroker): PreviewRelayWeb {
  const router = Router();
  const pollers = new Map<string, {
    queue: string[];
    waiter: ((message: string | null) => void) | null;
    detach: () => void;
  }>();
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.has('selvedge-preview') ? 'selvedge-preview' : false,
  });

  sockets.on('connection', (ws: WebSocket, req: IncomingMessage, previewId: string) => {
    const detach = broker.attach(previewId, {
      send: (message) => ws.send(message),
      close: (code, reason) => ws.close(code, reason),
    });
    ws.on('message', (message) => broker.receive(previewId, message.toString()));
    ws.on('close', detach);
    ws.on('error', detach);
    ws.send(JSON.stringify({ type: 'ready', previewId }));
  });

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    const match = /^\/workspace-relay\/connect\/([^/]+)$/.exec(url.pathname);
    if (!match) return false;
    const previewId = decodeURIComponent(match[1]!);
    const token = connectorCredential(req);
    try {
      const claims = token ? tokens.verifyConnector(token) : null;
      if (!claims || claims.previewId !== previewId) throw new Error('wrong preview');
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req, previewId));
    return true;
  }

  function verifyPoll(req: Request, previewId: string): boolean {
    try {
      const token = bearer(req);
      const claims = token ? tokens.verifyConnector(token) : null;
      return claims?.previewId === previewId;
    } catch {
      return false;
    }
  }

  function poller(previewId: string) {
    const found = pollers.get(previewId);
    if (found) return found;
    const state: { queue: string[]; waiter: ((message: string | null) => void) | null; detach: () => void } = {
      queue: [], waiter: null, detach: () => undefined,
    };
    state.detach = broker.attach(previewId, {
      send(message) {
        if (state.waiter) {
          const resolve = state.waiter;
          state.waiter = null;
          resolve(message);
        } else if (state.queue.length < 100) state.queue.push(message);
      },
      close() {
        pollers.delete(previewId);
        if (state.waiter) state.waiter(null);
        state.waiter = null;
      },
    });
    pollers.set(previewId, state);
    return state;
  }

  router.get('/workspace-relay/poll/:previewId', async (req, res) => {
    const previewId = req.params.previewId ?? '';
    if (!verifyPoll(req, previewId)) {
      res.status(401).json({ error: 'invalid connector capability' });
      return;
    }
    const state = poller(previewId);
    const queued = state.queue.shift();
    if (queued) {
      res.json({ message: queued });
      return;
    }
    const message = await new Promise<string | null>((resolve) => {
      state.waiter = resolve;
      const timer = setTimeout(() => {
        if (state.waiter !== resolve) return;
        state.waiter = null;
        resolve(null);
      }, 20_000);
      void timer;
    });
    if (!res.headersSent) res.json({ message });
  });

  router.post('/workspace-relay/poll/:previewId', async (req, res) => {
    const previewId = req.params.previewId ?? '';
    if (!verifyPoll(req, previewId)) {
      res.status(401).json({ error: 'invalid connector capability' });
      return;
    }
    const body = await bodyOf(req);
    if (!body.length) {
      res.status(400).json({ error: 'relay response is required' });
      return;
    }
    poller(previewId);
    broker.receive(previewId, body.toString('utf8'));
    res.status(202).json({ ok: true });
  });

  router.use('/workspace-preview/:previewId', async (req, res) => {
    const previewId = req.params.previewId ?? '';
    const queryToken = typeof req.query.preview_token === 'string' ? req.query.preview_token : null;
    if (queryToken) {
      try {
        const claims = tokens.verifyViewer(queryToken);
        if (claims.previewId !== previewId) throw new Error('wrong preview');
        const maxAge = Math.max(0, Math.floor((claims.expiresAt - Date.now()) / 1000));
        res.setHeader(
          'Set-Cookie',
          `${VIEWER_COOKIE}=${encodeURIComponent(queryToken)}; Path=/workspace-preview/${encodeURIComponent(previewId)}/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        );
        const clean = new URL(req.originalUrl, 'http://relay.invalid');
        clean.searchParams.delete('preview_token');
        res.redirect(302, `${clean.pathname}${clean.search}`);
        return;
      } catch {
        res.status(401).send('Preview link is invalid or expired.');
        return;
      }
    }

    try {
      const claims = tokens.verifyViewer(cookie(req, VIEWER_COOKIE) ?? '');
      if (claims.previewId !== previewId) throw new Error('wrong preview');
      const prefix = previewPath(previewId);
      const path = req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) || '/' : '/';
      const body = await bodyOf(req);
      const forwarded = await broker.forward(previewId, {
        method: req.method,
        path,
        headers: safeRelayHeaders(req.headers as Record<string, string | string[] | undefined>),
        bodyBase64: body.length ? body.toString('base64') : null,
      });
      res.status(forwarded.status);
      const headers = safeRelayHeaders(forwarded.headers);
      const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : undefined;
      const rawBody = forwarded.bodyBase64 ? Buffer.from(forwarded.bodyBase64, 'base64') : Buffer.alloc(0);
      const responseBody = rewritePreviewBody(previewId, contentType, rawBody);
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== 'content-length') res.setHeader(name, value);
      }
      const location = res.getHeader('location');
      if (typeof location === 'string' && location.startsWith('/') && !location.startsWith(`${prefix}/`)) {
        res.setHeader('location', `${prefix}${location}`);
      }
      res.send(responseBody.length ? responseBody : undefined);
    } catch (error) {
      if (error instanceof PreviewRelayUnavailableError) {
        // The connector starts asynchronously inside the hosted workspace.
        // Keep the iframe on the same signed, cookie-backed URL and retry
        // without making the owner press Refresh during that short race.
        res.status(503).type('html').send('<!doctype html><meta http-equiv="refresh" content="2"><p>Preview is waking up.</p>');
      }
      else if (error instanceof PreviewRelayTimeoutError) res.status(504).send('Preview did not answer in time.');
      else res.status(401).send('Preview link is invalid or expired.');
    }
  });

  return { router, upgrade };
}
