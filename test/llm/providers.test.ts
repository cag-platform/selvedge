import { describe, it, expect } from 'vitest';
import { PROVIDER_WIRING, chatModelFor, platformKeyFor, wiringFor } from '../../src/server/llm/providers.js';
import { FUEL_PROVIDERS, LIVE_FUEL_PROVIDERS } from '../../src/server/connectors/registry.js';
import { AGENTS } from '../../src/shared/agents.js';

/**
 * HOW SIX PROVIDERS BECAME ONE SEAM.
 *
 * Every provider but Anthropic speaks the OpenAI chat-completions protocol at
 * its own base URL, so "support Kimi" is a row rather than a client. What these
 * tests hold is the part that isn't free: a table with holes in it fails at
 * runtime, in a chat turn, in front of somebody — not at build time.
 */
describe('the provider wiring table', () => {
  it('has a row for every provider the registry declares', () => {
    // A declared provider with no wiring is a connect screen that offers a key
    // nothing can use, and the failure surfaces on first message rather than
    // on save.
    for (const provider of FUEL_PROVIDERS) {
      expect(wiringFor(provider), provider).toBeTruthy();
    }
    expect(Object.keys(PROVIDER_WIRING).sort()).toEqual([...FUEL_PROVIDERS].sort());
  });

  it('gives every row the four things a call actually needs', () => {
    for (const [id, w] of Object.entries(PROVIDER_WIRING)) {
      expect(w.label.length, id).toBeGreaterThan(2);
      expect(w.envVar, id).toMatch(/^[A-Z0-9_]+$/);
      expect(w.chatModel.length, id).toBeGreaterThan(2);
      expect(w.chatModelEnv, id).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  it('points every OpenAI-compatible provider at an https endpoint', () => {
    for (const [id, w] of Object.entries(PROVIDER_WIRING)) {
      // Anthropic has its own client and OpenAI is the SDK's default; every
      // other row is the OpenAI client pointed somewhere, and a base URL that
      // isn't https is a key sent in the clear.
      if (id === 'anthropic' || id === 'openai') {
        expect(w.baseUrl, id).toBeNull();
        continue;
      }
      expect(w.baseUrl, id).toMatch(/^https:\/\//);
    }
  });

  /**
   * The one flag that fails loudly if it's wrong in the wrong direction.
   *
   * `json_object` works on every OpenAI-compatible endpoint. `json_schema`
   * does not, and sending it where it isn't supported rejects the whole
   * request rather than degrading — so an unverified provider must sit on
   * `json_object` and be promoted only after somebody checks the live API.
   */
  it('only claims schema support for the two providers it has been checked against', () => {
    const claimsSchema = Object.entries(PROVIDER_WIRING)
      .filter(([, w]) => w.structured === 'json_schema')
      .map(([id]) => id)
      .sort();
    expect(claimsSchema).toEqual(['anthropic', 'openai']);
  });

  it('lets a model be pinned without a deploy', () => {
    expect(chatModelFor('kimi', {} as NodeJS.ProcessEnv)).toBe(PROVIDER_WIRING.kimi.chatModel);
    expect(chatModelFor('kimi', { CHAT_MODEL_KIMI: 'kimi-k2-turbo' } as NodeJS.ProcessEnv)).toBe('kimi-k2-turbo');
    // An empty variable is not a model name; it means "unset".
    expect(chatModelFor('kimi', { CHAT_MODEL_KIMI: '  ' } as NodeJS.ProcessEnv)).toBe(PROVIDER_WIRING.kimi.chatModel);
  });

  it('reads each platform key from its own variable, and trims it', () => {
    expect(platformKeyFor('xai', { XAI_API_KEY: ' sk-xai ' } as NodeJS.ProcessEnv)).toBe('sk-xai');
    expect(platformKeyFor('xai', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(platformKeyFor('xai', { XAI_API_KEY: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('no two providers share a key variable', () => {
    // Two rows reading one variable is one provider quietly answering as
    // another, which the ledger would then attribute to the wrong place.
    const vars = Object.values(PROVIDER_WIRING).map((w) => w.envVar);
    expect(new Set(vars).size).toBe(vars.length);
  });
});

describe('the agents and the providers agree', () => {
  it('every live agent burns fuel something can actually build a client for', () => {
    for (const agent of AGENTS) {
      if (!agent.live) continue;
      expect(LIVE_FUEL_PROVIDERS, `${agent.id} → ${agent.provider}`).toContain(agent.provider);
    }
  });

  it('prices every agent from a real row rather than the fallback', async () => {
    // The fallback is deliberately the most expensive row in the table, so an
    // unpriced model doesn't undercount. That is right for safety and wrong
    // for use: at 30/180 per Mtok a conversation reaches its ceiling in a
    // handful of turns and the agent is unusable.
    const { readFileSync } = await import('node:fs');
    const table = JSON.parse(readFileSync('config/model-pricing.json', 'utf8')) as {
      models: Record<string, { input_per_mtok: number; output_per_mtok: number }>;
      fallback: { input_per_mtok: number };
    };
    for (const agent of AGENTS) {
      const row = table.models[agent.pricingModel];
      expect(row, `${agent.id} → ${agent.pricingModel}`).toBeTruthy();
      expect(row!.input_per_mtok).toBeLessThan(table.fallback.input_per_mtok);
    }
  });
});
