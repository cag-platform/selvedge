import { rateLimit, ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';
import { tenantOf } from './tenant.js';

/**
 * In-memory request throttles. The store is the library default — a Map in this
 * process, entries expiring with their window. NOTHING is written to Neon or any
 * external service, nothing polls, and an idle site costs nothing: a counter
 * exists only for an IP or org actively hammering an endpoint, and it is dropped
 * when the window passes. `trust proxy` is 1 in app.ts, so `req.ip` is the real
 * client behind Railway's edge.
 *
 * `skipReads` lets a throttle sit on a path whose GET is a legitimate poll
 * (companion pairing status, the connect UI's status reads) while still bounding
 * the POST that mints or spends.
 */
type LimitOpts = {
  perMinute: number;
  /** 'ip' for pre-auth endpoints; 'org' (falling back to IP) for authenticated spend/credential routes. */
  by: 'ip' | 'org';
  skipReads?: boolean;
};

const ipKey = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

const orgOrIpKey = (req: Request): string => {
  const org = (() => {
    try {
      return tenantOf(req);
    } catch {
      return null;
    }
  })();
  return org ?? ipKey(req);
};

export function limiter(opts: LimitOpts): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: opts.perMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down and try again shortly.' },
    keyGenerator: opts.by === 'ip' ? ipKey : orgOrIpKey,
    ...(opts.skipReads ? { skip: (req: Request) => req.method === 'GET' || req.method === 'HEAD' } : {}),
  });
}

/** Unauthenticated, IP-keyed: installer, error beacon. */
export const publicLimiter = () => limiter({ perMinute: 30, by: 'ip' });

/** Unauthenticated pairing: bound the POST, leave the polled status GET alone. */
export const pairingLimiter = () => limiter({ perMinute: 15, by: 'ip', skipReads: true });

/** Authenticated spend/credential POSTs (fuel verify, key minting, message posts). GET polls pass. */
export const sensitiveLimiter = (perMinute = 20) => limiter({ perMinute, by: 'org', skipReads: true });

/** Large uploads — each one is a multi-hundred-MB buffer, so this is the DoS-shaped one. */
export const uploadLimiter = () => limiter({ perMinute: 6, by: 'org' });
