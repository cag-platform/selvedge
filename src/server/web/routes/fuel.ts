import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { connectCredential, listConnected, revokeCredential, type CredentialKind } from '../../connectors/credentials/store.js';
import { vaultConfigured } from '../../connectors/credentials/crypto.js';
import { FUEL_PROVIDERS, type FuelProvider } from '../../connectors/fuel/resolve.js';
import { LIVE_FUEL_PROVIDERS } from '../../connectors/registry.js';
import { PROVIDER_WIRING } from '../../llm/providers.js';
import { AnthropicLlmClient } from '../../llm/anthropic.js';
import { OpenAiLlmClient } from '../../llm/openai.js';
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
 * Providers whose SUBSCRIPTION can drive a builder, as opposed to an API key.
 *
 * Anthropic only, and deliberately so. The Claude Code CLI reads a subscription
 * token from an environment variable, which is a thing a pasted secret can be.
 * The Codex CLI signs in to a ChatGPT account through its own browser flow and
 * writes the result inside the machine it ran on — not something a token
 * reproduces in a fresh sandbox. Offering the field anyway would be offering a
 * path that ends in an auth error on a metered minute, so the refusal is here,
 * at the moment of pasting, where it costs nothing.
 */
const SUBSCRIPTION_PROVIDERS: FuelProvider[] = ['anthropic'];

/**
 * A liveness check: a tiny real call that proves the key works before we tell
 * the customer it's connected. Injected so tests don't hit the network; the
 * mounted app passes the real one. Returns true/false, never throws.
 */
export type FuelVerifier = (provider: FuelProvider, key: string) => Promise<boolean>;

/** The cheapest model each live provider will answer a ping on — the check costs a fraction of a cent. */
const PING_MODEL: Partial<Record<FuelProvider, string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
};

const realVerifier: FuelVerifier = async (provider, key) => {
  const model = PING_MODEL[provider];
  if (!model) return false;
  const client: LlmClient = provider === 'openai' ? new OpenAiLlmClient(key) : new AnthropicLlmClient(key);
  const res = await client.complete({
    model,
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
        // Named from the one wiring table, so the connect screen and the thing
        // that actually makes the call can never disagree about who a provider is.
        labels: Object.fromEntries(FUEL_PROVIDERS.map((p) => [p, PROVIDER_WIRING[p].label])),
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

      const { provider, key, label, kind } = req.body as {
        provider?: unknown;
        key?: unknown;
        label?: unknown;
        kind?: unknown;
      };

      if (!isFuelProvider(provider)) {
        res.status(400).json({ error: 'provide a supported provider' });
        return;
      }
      if (typeof key !== 'string' || key.trim().length < 8 || key.length > 500) {
        res.status(400).json({ error: 'provide a key' });
        return;
      }
      const cleanLabel = typeof label === 'string' && label.length <= 80 ? label : undefined;

      /**
       * AN API KEY OR A SUBSCRIPTION — the vault has always had both kinds, and
       * this is where an owner gets to say which they are pasting.
       *
       * It is not cosmetic. A Claude subscription token and an Anthropic API key
       * are read from DIFFERENT environment variables by the CLI that builds
       * (see build/builderAuth.ts), so a token stored under the wrong kind is a
       * credential that silently isn't found, inside a sandbox the owner has
       * already been metered for.
       */
      const credentialKind: CredentialKind = kind === 'subscription' ? 'subscription' : 'api_key';

      if (!LIVE_PROVIDERS.includes(provider)) {
        res.status(400).json({ error: `${provider} isn't supported yet — it's on the way`, coming_soon: true });
        return;
      }

      if (credentialKind === 'subscription') {
        /**
         * NOT PINGED, AND SAID SO. A subscription token doesn't authenticate
         * against the messages API — the only thing that can prove it is the CLI
         * that uses it, inside a sandbox. Verifying it here would reject a
         * perfectly good token; claiming we had verified it would be a lie on a
         * screen whose entire promise is that "connected" means "works".
         *
         * So it is stored, and the response says plainly that it hasn't been
         * checked yet. The first build proves it.
         */
        if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
          res.status(400).json({
            error: `A ${PROVIDER_WIRING[provider].label} subscription can't be used here yet — connect an API key instead.`,
          });
          return;
        }
        const saved = await connectCredential(db, orgIdOf(req), provider, key.trim(), {
          kind: 'subscription',
          ...(cleanLabel ? { label: cleanLabel } : {}),
        });
        res.json({
          connected: saved,
          verified: false,
          note: "Saved. A subscription can't be checked from here the way a key can — the first build will prove it.",
        });
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
