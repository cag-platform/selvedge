import httpProxy from 'http-proxy';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projectBuild } from '../db/schema/index.js';
import { isAllowedPreviewUrl } from '../../shared/preview.js';

/**
 * The preview proxy — ported from Toile (its Phase 19). Daytona shows a
 * "Preview URL Warning" interstitial on cross-origin browser requests to the
 * preview host; it's skipped when a request carries the
 * `X-Daytona-Skip-Preview-Warning: true` header — but an iframe can't set
 * request headers. So previews are served from `https://<slug>.<PREVIEW_DOMAIN>/`
 * instead: this proxy resolves the slug to the project's STORED, allowlisted
 * Daytona origin (SSRF-safe — it never forwards anywhere else), and injects the
 * header on every upstream request, HTTP and the Vite HMR websocket alike. The
 * interstitial never reaches the browser. Because the app sits at the subdomain
 * root, absolute asset paths and the websocket resolve back through the proxy
 * with no per-framework changes.
 *
 * Env-flagged on PREVIEW_DOMAIN: unset → the whole thing is inert and previews
 * fall back to the signed direct Daytona URL (warning included).
 */

/** The unique, unguessable-enough subdomain label for a project's preview. */
export function previewSlugFor(orgId: string, projectId: string): string {
  const base = projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'app';
  const hash = createHash('sha256').update(`${orgId}:${projectId}`).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** The slug label if the host is a preview subdomain, else null. */
export function hostSlug(host: string | undefined, domain: string | undefined = process.env.PREVIEW_DOMAIN): string | null {
  if (!domain || !host) return null;
  const bare = host.split(':')[0]!;
  const suffix = `.${domain}`;
  if (!bare.endsWith(suffix)) return null;
  const label = bare.slice(0, bare.length - suffix.length);
  return label && !label.includes('.') ? label : null;
}

const CACHE_MS = 30_000;

const UNAVAILABLE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview</title>' +
  '<style>body{font-family:system-ui,sans-serif;background:#f4f2ec;color:#1a1f26;display:grid;place-items:center;height:100vh;margin:0}div{max-width:30rem;padding:2rem;text-align:center}</style>' +
  '</head><body><div><h2>Preview unavailable</h2><p>This preview is asleep or has not been built yet. Open the project’s workshop in Selvedge to wake it.</p></div></body></html>';

export type PreviewProxy = {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  upgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
  /** Exposed for tests: resolve a slug to its proxy target (or null). */
  targetForSlug: (slug: string) => Promise<string | null>;
};

export function createPreviewProxy(db: Db): PreviewProxy {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });
  // Inject the skip-warning header on every upstream HTTP and WS request.
  proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Daytona-Skip-Preview-Warning', 'true'));
  proxy.on('proxyReqWs', (proxyReq) => proxyReq.setHeader('X-Daytona-Skip-Preview-Warning', 'true'));
  // Per-call error callbacks handle failures; this just prevents an unhandled event.
  proxy.on('error', () => {});

  const cache = new Map<string, { target: string | null; expires: number }>();

  async function targetForSlug(slug: string): Promise<string | null> {
    const now = Date.now();
    const cached = cache.get(slug);
    if (cached && cached.expires > now) return cached.target;

    const [row] = await db.select({ previewUrl: projectBuild.previewUrl }).from(projectBuild).where(eq(projectBuild.previewSlug, slug)).limit(1);
    // SSRF-safe: only ever proxy to the project's own stored, allowlisted Daytona URL.
    const target = row?.previewUrl && isAllowedPreviewUrl(row.previewUrl) ? new URL(row.previewUrl).origin : null;
    cache.set(slug, { target, expires: now + CACHE_MS });
    return target;
  }

  function sendUnavailable(res: Response, status: number): void {
    if (!res.headersSent) res.status(status).type('html').send(UNAVAILABLE_HTML);
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const slug = hostSlug(req.hostname);
    if (!slug) {
      next();
      return;
    }
    void targetForSlug(slug)
      .then((target) => {
        if (!target) {
          sendUnavailable(res, 503);
          return;
        }
        proxy.web(req, res, { target }, () => sendUnavailable(res, 502));
      })
      .catch(() => sendUnavailable(res, 502));
  }

  function upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    const slug = hostSlug(host);
    if (!slug) return; // not ours — leave it for any other upgrade handler
    void targetForSlug(slug)
      .then((target) => {
        if (!target) {
          socket.destroy();
          return;
        }
        proxy.ws(req, socket, head, { target }, () => socket.destroy());
      })
      .catch(() => socket.destroy());
  }

  return { middleware, upgrade, targetForSlug };
}

// One shared instance: the app middleware and the server's websocket upgrade
// handler must share the proxy and its cache.
let shared: PreviewProxy | null = null;
export function getPreviewProxy(db: Db): PreviewProxy {
  if (!shared) shared = createPreviewProxy(db);
  return shared;
}
