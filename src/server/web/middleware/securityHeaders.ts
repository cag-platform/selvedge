import type { Request, Response, NextFunction } from 'express';

/**
 * The security headers the product origin asserts on every response.
 *
 * Written inline rather than via helmet so the Content-Security-Policy can be
 * tuned exactly to what this app loads and nothing broader. These are static
 * strings computed once — no per-request work, no I/O, nothing that ticks.
 *
 * WHAT THE CSP HAS TO ALLOW. The SPA is same-origin JS/CSS. Clerk loads its
 * frontend SDK from its own hosts and talks to its API; fonts come from Google
 * Fonts (see index.html); provider/avatar images and the OG image can be
 * remote. `connect-src` stays broad because the browser calls the app's own
 * `/api` (same origin) and Clerk — a stricter list would break sign-in on the
 * first deploy, which is the wrong place to discover a policy change. The
 * preview relay does NOT inherit this policy: it forces its own, stricter
 * sandbox CSP per response (workspace/relay/protocol.ts).
 */
const CSP = [
  "default-src 'self'",
  // Clerk injects its SDK and needs inline bootstrap; Vite ships hashed assets.
  "script-src 'self' 'unsafe-inline' https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.clerk.com https://*.clerk.accounts.dev https://clerk.tryselvedge.com",
  // Clerk renders its CAPTCHA / hosted components in frames.
  "frame-src 'self' https://*.clerk.com https://challenges.cloudflare.com",
  // The product must not be framable by other sites (clickjacking).
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Applied to every non-preview response. The preview relay router is mounted
 * ahead of this and sets its own headers, so agent-written app output never
 * receives the product policy.
 */
export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    // Railway terminates TLS; assert HSTS so the browser refuses http next time.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Don't advertise the framework.
    res.removeHeader('X-Powered-By');
    next();
  };
}
