import type { Db } from '../../db/client.js';
import type { LlmClient } from '../../llm/types.js';
import { AnthropicLlmClient } from '../../llm/anthropic.js';
import { useCredential } from '../credentials/store.js';

/**
 * The fuel connector — turns a stored credential into a live model client.
 *
 * "Fuel" is the customer's model access (§25.3): they bring their own Claude /
 * GPT / Gemini / Kimi key or subscription, and Selvedge charges for the layer,
 * not the tokens. This resolver is the seam that makes that real.
 *
 * Provider-agnostic in shape, ONE provider live today (§25.4 — build the seam,
 * ship one well). Adding a provider is a case in `clientFor`, not a new
 * architecture. An unknown or not-yet-built provider returns null (treated as
 * "no fuel"), never a broken client.
 *
 * Resolution order — BYO, then managed, then off:
 *   1. The org's own connected credential (BYO). This is the default and the
 *      whole point: their fuel powers their work.
 *   2. The platform key from the environment (managed fuel / dogfooding), if
 *      one is configured. This is what runs today with ANTHROPIC_API_KEY and
 *      what a managed-tier customer without their own subscription would use.
 *   3. Nothing → null → the product runs its deterministic path (template
 *      narration, mechanical brief), exactly as it does when the voice is off.
 */

export const FUEL_PROVIDERS = ['anthropic', 'openai', 'gemini', 'kimi'] as const;
export type FuelProvider = (typeof FUEL_PROVIDERS)[number];

export type ResolvedFuel = {
  client: LlmClient;
  provider: FuelProvider;
  /** 'byo' = the org's own credential; 'managed' = the platform env key. */
  source: 'byo' | 'managed';
};

/** Build a client for a provider from a raw key. One provider live; the rest are declared but not yet built. */
function clientFor(provider: FuelProvider, apiKey: string): LlmClient | null {
  switch (provider) {
    case 'anthropic':
      return new AnthropicLlmClient(apiKey);
    // Declared so the seam and the connect UI are honest about the roadmap,
    // but not yet built — return null rather than a client that would fail on
    // first use. Wired one at a time on real demand (§25.4).
    case 'openai':
    case 'gemini':
    case 'kimi':
      return null;
    default:
      return null;
  }
}

/**
 * Resolve the model client for an org, following BYO → managed → off. Returns
 * null when the org has no usable fuel and no platform key is configured — the
 * caller degrades to the deterministic path.
 */
export async function resolveFuel(db: Db, orgId: string): Promise<ResolvedFuel | null> {
  // 1. BYO — the org's own connected fuel, tried in a stable provider order.
  for (const provider of FUEL_PROVIDERS) {
    const secret = await useCredential(db, orgId, provider);
    if (!secret) continue;
    const client = clientFor(provider, secret);
    if (client) return { client, provider, source: 'byo' };
    // A stored credential for a provider we can't yet build a client for is
    // skipped, not fatal — the customer connected ahead of our support.
  }

  // 2. Managed — the platform key (dogfood / managed tier). Anthropic only today.
  const platformKey = process.env.ANTHROPIC_API_KEY;
  if (platformKey) {
    return { client: new AnthropicLlmClient(platformKey), provider: 'anthropic', source: 'managed' };
  }

  // 3. Off.
  return null;
}
