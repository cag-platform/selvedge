import type { Request, Response, NextFunction } from 'express';

/**
 * Cross-site request guard for state-changing API calls — CSRF defense in depth.
 *
 * Auth is a SameSite=Lax Clerk cookie, which already stops classic cross-site
 * form POSTs. This adds a second, explicit fence: a browser always sends an
 * `Origin` header on a non-GET fetch, so a request that carries an Origin from
 * another site is refused outright rather than relying on the cookie policy
 * alone. It is pure header inspection — no I/O, no state, nothing that ticks.
 *
 * WHY IT DOESN'T BREAK THE COMPANION. Non-browser clients (the CLI, server-to-
 * server) send no Origin header at all, and they authenticate with a bearer key
 * rather than the cookie. A missing Origin is therefore allowed; only a PRESENT,
 * MISMATCHED Origin is rejected. Safe methods (GET/HEAD/OPTIONS) always pass.
 */
export function sameOriginGuard() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.get('origin');
    if (!origin) {
      // No Origin: a non-browser client. Its bearer/webhook auth is the fence.
      next();
      return;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      res.status(403).json({ error: 'bad origin' });
      return;
    }
    const allowed = new Set<string>();
    const host = req.get('host');
    if (host) allowed.add(host);
    const publicOrigin = process.env.PUBLIC_ORIGIN?.trim();
    if (publicOrigin) {
      try {
        allowed.add(new URL(publicOrigin).host);
      } catch { /* misconfig surfaced elsewhere */ }
    }
    if (!allowed.has(originHost)) {
      res.status(403).json({ error: 'cross-site request refused' });
      return;
    }
    next();
  };
}
