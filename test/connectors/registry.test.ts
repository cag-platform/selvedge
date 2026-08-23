import { describe, it, expect } from 'vitest';
import {
  FUEL_PROVIDERS,
  LIVE_FUEL_PROVIDERS,
  HOST_CREDENTIAL_PROVIDERS,
  HOST_TOPOLOGY_CONNECTORS,
} from '../../src/server/connectors/registry.js';

/**
 * Membership locks. These lists used to live in four files and drift; now they
 * derive from one table, and this test pins the exact membership so a registry
 * edit that would silently change a surface (which providers connect, which
 * deploys get watched) fails loudly instead. Deliberate changes update both.
 */
describe('connectors/registry — one table, four derived surfaces', () => {
  it('fuel: seven declared, anthropic first (BYO resolution order), every one live', () => {
    // Declaration order is resolution order for BYO, so anthropic staying
    // first is not cosmetic: it is which key answers when an org has several.
    expect(FUEL_PROVIDERS).toEqual(['anthropic', 'openai', 'gemini', 'kimi', 'xai', 'deepseek', 'mistral']);
    // Nothing is declared-but-unbuildable any more. That gap used to be the
    // roadmap surface; now every row reaches a real endpoint through the one
    // OpenAI-compatible seam, and the connect screen has nothing to apologise
    // for. If a row is ever added ahead of its wiring, this is where the two
    // lists part company and say so.
    expect(LIVE_FUEL_PROVIDERS).toEqual([...FUEL_PROVIDERS]);
  });

  it('hosts: the named asymmetry holds — supabase takes a credential but is not a deploy target; replit the reverse', () => {
    expect(HOST_CREDENTIAL_PROVIDERS).toEqual(['railway', 'vercel', 'supabase']);
    expect([...HOST_TOPOLOGY_CONNECTORS].sort()).toEqual(['railway', 'replit', 'vercel']);
  });
});
