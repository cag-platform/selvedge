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
 * Providers whose SUBSCRIPTION (a flat plan, not a metered key) can drive a
 * builder.
 *
 * Anthropic is here for the tokens already stored — the paste path is no
 * longer offered in the UI since Anthropic locked consumer plans to its own
 * apps. Kimi and Z.ai are the opposite case: their coding plans are SOLD for
 * use in third-party tools, and the key each plan issues authenticates on an
 * Anthropic-compatible coding endpoint rather than the provider's metered
 * chat API. Stored as kind 'subscription' so chat resolution skips them
 * (fuel/resolve.ts) and the builder wiring picks the coding endpoint.
 *
 * ChatGPT stays absent deliberately: the Codex CLI signs in to a ChatGPT
 * account through its own browser flow and writes the result inside the
 * machine it ran on — not something a pasted token reproduces in a fresh
 * sandbox. That path runs through the computer bridge instead.
 */
const SUBSCRIPTION_PROVIDERS: FuelProvider[] = ['anthropic', 'kimi', 'zai'];

/**
 * A liveness check: a tiny real call that proves the key works before we tell
 * the customer it's connected. Injected so tests don't hit the network; the
 * mounted app passes the real one. Only called for credentials that CAN be
 * checked from here — the route skips it for the one kind that can't (an
 * Anthropic subscription token: only the CLI that uses it can prove it).
 * Returns true/false, never throws.
 */
export type FuelVerifier = (provider: FuelProvider, key: string, kind: CredentialKind) => Promise<boolean>;

/** The cheapest model each live provider will answer a ping on — the check costs a fraction of a cent. */
const PING_MODEL: Partial<Record<FuelProvider, string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.6-luna',
  gemini: PROVIDER_WIRING.gemini.chatModel,
  kimi: PROVIDER_WIRING.kimi.chatModel,
  xai: PROVIDER_WIRING.xai.chatModel,
  deepseek: PROVIDER_WIRING.deepseek.chatModel,
  mistral: PROVIDER_WIRING.mistral.chatModel,
};

/**
 * Where a coding-plan key answers. These endpoints speak the ANTHROPIC
 * protocol — the same one their published Claude Code integrations use — so
 * the ping goes through the Anthropic client pointed at them, and the model
 * is the cheapest one each plan serves.
 */
const CODING_PLAN_PING: Partial<Record<FuelProvider, { baseURL: string; model: string }>> = {
  kimi: { baseURL: 'https://api.kimi.ai/coding/', model: 'kimi-for-coding' },
  zai: { baseURL: 'https://api.z.ai/api/anthropic', model: 'glm-5.3-flash' },
};

/** Can a credential of this shape be proven live from here at all? */
function verifiable(provider: FuelProvider, kind: CredentialKind): boolean {
  return kind === 'api_key' || CODING_PLAN_PING[provider] !== undefined;
}

const realVerifier: FuelVerifier = async (provider, key, kind) => {
  const codingPlan = kind === 'subscription' ? CODING_PLAN_PING[provider] : undefined;
  const model = codingPlan?.model ?? PING_MODEL[provider];
  if (!model) return false;
  const wiring = PROVIDER_WIRING[provider];
  const client: LlmClient = codingPlan
    ? new AnthropicLlmClient(key, { baseURL: codingPlan.baseURL })
    : provider === 'anthropic'
      ? new AnthropicLlmClient(key)
      : new OpenAiLlmClient(key, {
          ...(wiring.baseUrl ? { baseURL: wiring.baseUrl } : {}),
          provider,
          structured: wiring.structured,
        });
  const res = await client.complete({
    model,
    system: 'Reply in the required format.',
    userContent: 'ping',
    maxTokens: 16,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  });
  if (res.ok) return true;
  // The key is what's on trial, nothing else. A 401/403 is the key failing;
  // a refusal, a schema quirk, or a 4xx about our request shape still proves
  // the key authenticated. A transport failure proves nothing, and a key we
  // can't verify is a key we don't store.
  if (/^api_error_40[13]$/.test(res.reason)) return false;
  return res.reason !== 'network_or_timeout';
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

      if (credentialKind === 'subscription' && !SUBSCRIPTION_PROVIDERS.includes(provider)) {
        res.status(400).json({
          error: `A ${PROVIDER_WIRING[provider].label} subscription can't be used here yet — connect an API key instead.`,
        });
        return;
      }

      /**
       * Verified when it CAN be. A coding-plan key (Kimi, Z.ai) answers on its
       * own endpoint, so it's pinged like any key. An Anthropic subscription
       * token doesn't authenticate against anything reachable from here — it's
       * stored unpinged, and the response says plainly that only the first
       * build can prove it. Claiming otherwise would be a lie on the one
       * screen whose promise is "connected" means "works" — and rejecting it
       * on a failed ping would refuse a good token.
       */
      const live = verifiable(provider, credentialKind) ? await verify(provider, key.trim(), credentialKind) : null;
      if (live === false) {
        // Do not store a key we couldn't verify — the customer would see
        // "connected" and then silently get the deterministic path.
        res.status(422).json({ error: "that key didn't work — check it and try again", verified: false });
        return;
      }

      const saved = await connectCredential(db, orgIdOf(req), provider, key.trim(), {
        kind: credentialKind,
        ...(cleanLabel ? { label: cleanLabel } : {}),
      });
      res.json({
        connected: saved,
        verified: live === true,
        ...(live === null
          ? { note: "Saved. A subscription can't be checked from here the way a key can — the first build will prove it." }
          : {}),
      });
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
