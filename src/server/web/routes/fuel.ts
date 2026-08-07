import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { connectCredential, listConnected, revokeCredential } from '../../connectors/credentials/store.js';
import { vaultConfigured } from '../../connectors/credentials/crypto.js';
import { FUEL_PROVIDERS, type FuelProvider } from '../../connectors/fuel/resolve.js';
import { LIVE_FUEL_PROVIDERS } from '../../connectors/registry.js';
import { AnthropicLlmClient } from '../../llm/anthropic.js';
import type { LlmClient } from '../../llm/types.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/** Providers we can actually build a client for today (a subset of the declared FUEL_PROVIDERS). */
const LIVE_PROVIDERS: FuelProvider[] = LIVE_FUEL_PROVIDERS;

function isFuelProvider(v: unknown): v is FuelProvider {
  return typeof v === 'string' && (FUEL_PROVIDERS as readonly string[]).includes(v);
}

/**
 * A liveness check: a tiny real call that proves the key works before we tell
 * the customer it's connected. Injected so tests don't hit the network; the
 * mounted app passes the real one. Returns true/false, never throws.
 */
export type FuelVerifier = (provider: FuelProvider, key: string) => Promise<boolean>;

const realVerifier: FuelVerifier = async (provider, key) => {
  if (provider !== 'anthropic') return false;
  const client: LlmClient = new AnthropicLlmClient(key);
  const res = await client.complete({
    model: 'claude-haiku-4-5-20251001', // cheapest model — the check costs a fraction of a cent
    system: 'Reply in the required format.',
    userContent: 'ping',
    maxTokens: 16,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  });
  // A transport/auth failure is a failed verification; a refusal still proves
  // the key authenticated, so only a hard failure counts as "not live".
  return res.ok || res.reason !== 'network_or_timeout';
};

/**
 * The fuel connector's HTTP surface. Connect (with a liveness check so a bad
 * key never reports success), list (display-only, never the secret), revoke
 * (a delete). This is the BYO experience from §25.3.
 */
export function createFuelRouter(db: Db, verify: FuelVerifier = realVerifier) {
  const router = Router();

  // What's connected — provider, kind, last4, status. Never the secret.
  router.get(
    '/api/fuel',
    asyncHandler(async (req, res) => {
      const all = await listConnected(db, orgIdOf(req));
      const fuel = all.filter((c) => (FUEL_PROVIDERS as readonly string[]).includes(c.provider));
      res.json({
        connected: fuel,
        available: LIVE_PROVIDERS,
        coming_soon: FUEL_PROVIDERS.filter((p) => !LIVE_PROVIDERS.includes(p)),
      });
    }),
  );

  // Connect a key. Verified live before it is stored, so "connected" is true.
  router.post(
    '/api/fuel',
    asyncHandler(async (req, res) => {
      // A missing vault key must be a plain sentence, never an "internal error".
      if (!vaultConfigured()) {
        res.status(503).json({ error: "I can't store keys yet — the server's credential vault isn't configured (CREDENTIALS_KEY needs to be set in the deploy, at least 32 characters). Nothing was saved." });
        return;
      }

      const { provider, key, label } = req.body as { provider?: unknown; key?: unknown; label?: unknown };

      if (!isFuelProvider(provider)) {
        res.status(400).json({ error: 'provide a supported provider' });
        return;
      }
      if (typeof key !== 'string' || key.trim().length < 8 || key.length > 500) {
        res.status(400).json({ error: 'provide a key' });
        return;
      }
      const cleanLabel = typeof label === 'string' && label.length <= 80 ? label : undefined;

      if (!LIVE_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: `${provider} isn't supported yet — it's on the way`, coming_soon: true });
        return;
      }

      const live = await verify(provider, key.trim());
      if (!live) {
        // Do not store a key we couldn't verify — the customer would see
        // "connected" and then silently get the deterministic path.
        res.status(422).json({ error: "that key didn't work — check it and try again", verified: false });
        return;
      }

      const saved = await connectCredential(db, orgIdOf(req), provider, key.trim(), {
        kind: 'api_key',
        ...(cleanLabel ? { label: cleanLabel } : {}),
      });
      res.json({ connected: saved, verified: true });
    }),
  );

  // Revoke = delete. One provider's fuel, gone.
  router.delete(
    '/api/fuel/:provider',
    asyncHandler(async (req, res) => {
      const provider = req.params.provider ?? '';
      if (!(FUEL_PROVIDERS as readonly string[]).includes(provider)) {
        res.status(400).json({ error: 'unknown provider' });
        return;
      }
      const removed = await revokeCredential(db, orgIdOf(req), provider);
      res.json({ removed });
    }),
  );

  return router;
}
