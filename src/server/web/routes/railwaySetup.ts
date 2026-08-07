import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { beginOAuthState, takeOAuthState } from '../../connectors/oauthState.js';
import {
  authorizeUrl,
  exchangeCode,
  loadRailwayOAuthConfig,
  makePkce,
  railwayOAuthConfigured,
  storeTokenSet,
  type RailwayOAuthConfig,
  type RailwayTokenSet,
} from '../../connectors/railway/oauth.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

const PROVIDER = 'railway';

/**
 * "Login with Railway", over HTTP — the last wire in the go-live path.
 *
 * The OAuth module underneath was written, unit-tested and then never called:
 * makePkce, authorizeUrl and exchangeCode had no callers anywhere. This router
 * is the missing half. It deliberately does NOT copy the GitHub setup router's
 * in-process Map of pending handshakes; PKCE means the verifier generated at
 * /start is required at /callback, so losing it to a redeploy or a second
 * replica doesn't degrade the flow, it breaks it. State lives in the database
 * (connectors/oauthState.ts) and is random rather than a counter.
 *
 * The exchange is injectable so the whole flow is testable without Railway.
 */
export type RailwaySetupDeps = {
  exchange?: (config: RailwayOAuthConfig, code: string, verifier: string) => Promise<RailwayTokenSet>;
  loadConfig?: () => RailwayOAuthConfig;
  configured?: () => boolean;
};

export function createRailwaySetupRouter(db: Db, deps: RailwaySetupDeps = {}) {
  const router = Router();
  const isConfigured = deps.configured ?? railwayOAuthConfigured;
  const config = deps.loadConfig ?? loadRailwayOAuthConfig;
  const exchange = deps.exchange ?? exchangeCode;

  router.post(
    '/api/connectors/railway/start',
    asyncHandler(async (req, res) => {
      if (!isConfigured()) {
        // Plain about the one thing they can still do, rather than a 500 that
        // reads like the product is broken.
        res.status(503).json({
          error: "One-click Railway sign-in isn't switched on yet. You can paste a Railway token on this page instead — it works the same way.",
        });
        return;
      }
      const orgId = orgIdOf(req);
      const pkce = makePkce();
      const state = await beginOAuthState(db, orgId, PROVIDER, pkce.verifier);
      // Returned rather than redirected, matching the GitHub setup flow: the
      // client opens it in a popup so the owner never leaves the page.
      res.json({ authorize_url: authorizeUrl(config(), state, pkce.challenge), state });
    }),
  );

  router.get(
    '/api/connectors/railway/callback',
    asyncHandler(async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';

      // Railway reports a refusal on the redirect, not as an exception. Saying
      // "you declined" is not the same as "something broke", and the owner
      // should be told which one happened.
      const denied = typeof req.query.error === 'string' ? req.query.error : '';
      if (denied) {
        res.status(400).json({ ok: false, message: `Railway didn't complete the connection (${denied}). Nothing was changed.` });
        return;
      }

      // Consumed here, so a replayed callback finds nothing. Note the org comes
      // from the stored handshake, never from the query string — the callback
      // arrives from Railway, not from a session we can trust.
      const handshake = await takeOAuthState(db, state, PROVIDER);
      if (!code || !handshake?.verifier) {
        res.status(400).json({ ok: false, message: "That link didn't carry what I needed, or it expired. Please start again." });
        return;
      }

      try {
        const tokens = await exchange(config(), code, handshake.verifier);
        await storeTokenSet(db, handshake.orgId, tokens);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        res.status(502).json({ ok: false, message: `I couldn't finish connecting Railway — ${detail}. Nothing was changed, and you can try again.` });
        return;
      }

      res.json({
        ok: true,
        message: "Your Railway account is connected. It stays in your name — you can disconnect it here or revoke it in Railway, and anything already online keeps running.",
      });
    }),
  );

  return router;
}
