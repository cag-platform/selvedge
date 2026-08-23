import type { Db } from '../../db/client.js';
import type { LlmClient } from '../../llm/types.js';
import { AnthropicLlmClient } from '../../llm/anthropic.js';
import { OpenAiLlmClient } from '../../llm/openai.js';
import { platformKeyFor, wiringFor } from '../../llm/providers.js';
import { useCredentialWithKind } from '../credentials/store.js';

/**
 * The fuel connector — turns a stored credential into a live model client.
 *
 * "Fuel" is the customer's model access (§25.3): they bring their own Claude /
 * GPT / Gemini / Kimi key or subscription, and Selvedge charges for the layer,
 * not the tokens. This resolver is the seam that makes that real.
 *
 * Provider-agnostic in shape, and now genuinely plural. Adding a provider is a
 * ROW in llm/providers.ts, not a case here and not a new architecture — every
 * provider but Anthropic speaks the OpenAI chat-completions protocol at its own
 * base URL, so the work is a URL and a model name. An unknown provider returns
 * null (treated as "no fuel"), never a broken client.
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

// The provider table lives in the registry; re-exported here so the fuel
// seam's import surface is unchanged.
export { FUEL_PROVIDERS, type FuelProvider } from '../registry.js';
import { FUEL_PROVIDERS, type FuelProvider } from '../registry.js';

export type ResolvedFuel = {
  client: LlmClient;
  provider: FuelProvider;
  /** 'byo' = the org's own credential; 'managed' = the platform env key. */
  source: 'byo' | 'managed';
};

/**
 * Build a client for a provider from a raw key.
 *
 * Anthropic keeps its own client: it was here first, and its structured-output
 * shape genuinely differs. Everything else is the OpenAI client pointed at a
 * different base URL, stamped with its own provider name so the ledger
 * attributes spend correctly, and told how that endpoint takes a schema.
 */
/**
 * AN API KEY, NOT A SUBSCRIPTION. Every client below talks to a messages or
 * chat-completions endpoint, and a subscription token does not authenticate
 * against one — it authenticates a CLI.
 *
 * This matters because ONE credential row serves two surfaces: an owner who
 * connects an Anthropic subscription is arming the Claude Code BUILDER
 * (build/builderAuth.ts), and the same row would otherwise be handed to the
 * chat client here, where it produces a 401 that reads as "your Claude
 * connection stopped working". So a chat turn skips a subscription rather than
 * failing on it, and falls through to the platform key or to the deterministic
 * path — the shape every other "no fuel" case already takes.
 */
function usableForChat(kind: string): boolean {
  return kind !== 'subscription';
}

function clientFor(provider: FuelProvider, apiKey: string): LlmClient | null {
  if (provider === 'anthropic') return new AnthropicLlmClient(apiKey);
  const wiring = wiringFor(provider);
  if (!wiring) return null;
  return new OpenAiLlmClient(apiKey, {
    ...(wiring.baseUrl ? { baseURL: wiring.baseUrl } : {}),
    provider,
    structured: wiring.structured,
  });
}

/**
 * Resolve the model client for an org, following BYO → managed → off. Returns
 * null when the org has no usable fuel and no platform key is configured — the
 * caller degrades to the deterministic path.
 */
export async function resolveFuel(db: Db, orgId: string): Promise<ResolvedFuel | null> {
  // 1. BYO — the org's own connected fuel, tried in a stable provider order.
  for (const provider of FUEL_PROVIDERS) {
    const connected = await useCredentialWithKind(db, orgId, provider);
    if (!connected || !usableForChat(connected.kind)) continue;
    const client = clientFor(provider, connected.secret);
    if (client) return { client, provider, source: 'byo' };
    // A stored credential for a provider we can't yet build a client for is
    // skipped, not fatal — the customer connected ahead of our support.
  }

  // 2. Managed — the platform key (dogfood / managed tier). Anthropic first,
  // because it is what this deployment actually carries; the loop after it
  // means a deployment configured for any other provider still has fuel rather
  // than falling through to "off" for a reason nobody wrote down.
  for (const provider of FUEL_PROVIDERS) {
    const platformKey = platformKeyFor(provider);
    if (!platformKey) continue;
    const client = clientFor(provider, platformKey);
    if (client) return { client, provider, source: 'managed' };
  }

  // 3. Off.
  return null;
}

/**
 * Resolve ONE named provider's client, for a surface where the provider is the
 * choice rather than an implementation detail — a general thread running on the
 * model the owner picked for it.
 *
 * Same order as resolveFuel (BYO, then the platform key), and the same honest
 * null: a provider the org hasn't connected and the platform can't cover is not
 * available, and the caller says so plainly rather than quietly answering as
 * somebody else.
 */
export async function resolveFuelFor(db: Db, orgId: string, provider: FuelProvider): Promise<ResolvedFuel | null> {
  const connected = await useCredentialWithKind(db, orgId, provider);
  if (connected && usableForChat(connected.kind)) {
    const client = clientFor(provider, connected.secret);
    if (client) return { client, provider, source: 'byo' };
  }
  const platformKey = platformKeyFor(provider);
  if (platformKey) {
    const client = clientFor(provider, platformKey);
    if (client) return { client, provider, source: 'managed' };
  }
  return null;
}
