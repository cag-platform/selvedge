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
  it('fuel: four declared, anthropic first (BYO resolution order), only anthropic live', () => {
    expect(FUEL_PROVIDERS).toEqual(['anthropic', 'openai', 'gemini', 'kimi']);
    expect(LIVE_FUEL_PROVIDERS).toEqual(['anthropic', 'openai']);
  });

  it('hosts: the named asymmetry holds — supabase takes a credential but is not a deploy target; replit the reverse', () => {
    expect(HOST_CREDENTIAL_PROVIDERS).toEqual(['railway', 'vercel', 'supabase']);
    expect([...HOST_TOPOLOGY_CONNECTORS].sort()).toEqual(['railway', 'replit', 'vercel']);
  });
});
