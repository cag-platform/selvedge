/**
 * The one provider table. Before this, four allow-lists disagreed quietly
 * across four files — fuel providers in two places, host providers in a third,
 * and ship's "which topology sources mean deploys" set in a fourth, where
 * `replit` was a host but `supabase` wasn't (the exact reverse of the hosts
 * route). Each list is now DERIVED from this table, so adding a connector is
 * one row, and a disagreement between surfaces is a visible flag difference
 * rather than two files drifting.
 *
 * The flags preserve today's membership exactly — including the asymmetries,
 * which are now named rather than accidental:
 *  - `supabase` takes a pasted credential but does not count as a deploy
 *    target for ship's watch handoff (its deploys aren't polled).
 *  - `replit` counts as a deploy target when it appears in a pack's topology,
 *    but the hosts route doesn't offer a paste-a-token path for it.
 * Resolving either is a product decision, not a refactor.
 *
 * HARD CONSTRAINT: provider ids are encryption-bound. The id string is an
 * AES-GCM AAD component (credentials/crypto.ts), so renaming or normalizing
 * one makes every stored credential row for it permanently undecryptable —
 * silently (decryption failure reads as "not connected"). Ids in this table
 * may be added, never renamed.
 */

type ProviderFlags = {
  /** A model provider — declared in the fuel seam and the connect UI. */
  fuel?: boolean;
  /** A fuel provider we can actually build a client for today. */
  fuelLive?: boolean;
  /** A host the hosts route accepts a pasted credential for. */
  hostCredential?: boolean;
  /** A topology connector ship treats as "something out there deploys this repo". */
  hostTopology?: boolean;
};

/** Order matters for fuel: BYO resolution tries providers in declaration order. */
const PROVIDERS = {
  anthropic: { fuel: true, fuelLive: true },
  // Live as of the Inbox: a general thread can run on GPT, so an org may now
  // connect an OpenAI key as fuel. The GRADER still does not use it — grading
  // is platform-scoped by construction (llm/factory.ts) precisely so a
  // customer's own key can never end up marking its own homework.
  openai: { fuel: true, fuelLive: true },
  gemini: { fuel: true },
  kimi: { fuel: true },
  railway: { hostCredential: true, hostTopology: true },
  vercel: { hostCredential: true, hostTopology: true },
  supabase: { hostCredential: true },
  replit: { hostTopology: true },
} satisfies Record<string, ProviderFlags>;

export type ProviderId = keyof typeof PROVIDERS;

function withFlag(flag: keyof ProviderFlags): ProviderId[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((id) => (PROVIDERS[id] as ProviderFlags)[flag]);
}

/** All declared model providers — the fuel seam's roadmap surface. */
export type FuelProvider = 'anthropic' | 'openai' | 'gemini' | 'kimi';
export const FUEL_PROVIDERS: readonly FuelProvider[] = withFlag('fuel') as FuelProvider[];

/** Fuel providers with a working client — the only ones connect/advertise offers. */
export const LIVE_FUEL_PROVIDERS: FuelProvider[] = withFlag('fuelLive') as FuelProvider[];

/** Hosts the hosts route accepts a pasted credential for. */
export const HOST_CREDENTIAL_PROVIDERS = withFlag('hostCredential');
export type HostProvider = 'railway' | 'vercel' | 'supabase';

/** Topology connectors that mean "something out there deploys this repo". */
export const HOST_TOPOLOGY_CONNECTORS: ReadonlySet<string> = new Set(withFlag('hostTopology'));
