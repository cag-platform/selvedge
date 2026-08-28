import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Router, type Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PreviewRelayBroker, PreviewRelayTimeoutError, PreviewRelayUnavailableError } from './broker.js';
import { safeRelayHeaders } from './protocol.js';
import { PreviewRelaySessions } from './session.js';

const VIEWER_COOKIE = 'selvedge_preview';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

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
      const prefix = `/workspace-preview/${previewId}`;
      const path = req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) || '/' : '/';
      const body = await bodyOf(req);
      const forwarded = await broker.forward(previewId, {
        method: req.method,
        path,
        headers: safeRelayHeaders(req.headers as Record<string, string | string[] | undefined>),
        bodyBase64: body.length ? body.toString('base64') : null,
      });
      res.status(forwarded.status);
      for (const [name, value] of Object.entries(safeRelayHeaders(forwarded.headers))) res.setHeader(name, value);
      res.send(forwarded.bodyBase64 ? Buffer.from(forwarded.bodyBase64, 'base64') : undefined);
    } catch (error) {
      if (error instanceof PreviewRelayUnavailableError) res.status(503).send('Preview is waking up.');
      else if (error instanceof PreviewRelayTimeoutError) res.status(504).send('Preview did not answer in time.');
      else res.status(401).send('Preview link is invalid or expired.');
    }
  });

  return { router, upgrade };
}
