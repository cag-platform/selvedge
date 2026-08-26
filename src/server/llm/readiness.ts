import type { Db } from '../db/client.js';
import type { AgentProvider } from '../../shared/agents.js';
import { resolveFuelFor } from '../connectors/fuel/resolve.js';

export type ModelReadiness = {
  state: 'available' | 'unavailable' | 'unknown';
  checked_at: string | null;
  code: string | null;
  note: string | null;
};

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { expires: number; value: ModelReadiness }>();

function interpreted(provider: AgentProvider, reason: string | undefined, checkedAt: string): ModelReadiness {
  if (reason === 'api_error_404' && (provider === 'openai' || provider === 'anthropic')) return { state: 'unavailable', checked_at: checkedAt, code: 'model_unavailable', note: 'This model is not available to the connected account.' };
  if (reason === 'api_error_401' || reason === 'api_error_403') return { state: 'unavailable', checked_at: checkedAt, code: 'credential_rejected', note: 'The provider rejected the connected credential.' };
  return { state: 'unknown', checked_at: checkedAt, code: reason ?? 'probe_unsupported', note: 'Model access could not be confirmed just now.' };
}

/** Cached, non-generating readiness check. It never spends completion tokens. */
export async function modelReadiness(db: Db, orgId: string, provider: AgentProvider, model: string, now = new Date()): Promise<ModelReadiness> {
  const key = `${orgId}:${provider}:${model}`;
  const cached = cache.get(key);
  if (cached && cached.expires > now.getTime()) return cached.value;
  const fuel = await resolveFuelFor(db, orgId, provider).catch(() => null);
  if (!fuel) return { state: 'unavailable', checked_at: null, code: 'no_fuel', note: 'No usable credential is connected.' };
  if (!fuel.client.probeModel) return { state: 'unknown', checked_at: null, code: 'probe_unsupported', note: 'This provider cannot be checked without making a real request.' };
  const checkedAt = now.toISOString();
  const result = await fuel.client.probeModel(model);
  const value: ModelReadiness = result.available
    ? { state: 'available', checked_at: checkedAt, code: null, note: null }
    : interpreted(provider, result.reason, checkedAt);
  cache.set(key, { expires: now.getTime() + TTL_MS, value });
  return value;
}

export function clearModelReadinessCache(): void { cache.clear(); }
