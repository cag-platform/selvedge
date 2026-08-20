import { describe, it, expect } from 'vitest';
import { AGENTS, agentById, agentsFor, defaultAgentFor, isAgentId, liveAgentsFor } from '../../src/shared/agents.js';

/**
 * The registry is read by the thread store, the handoff composer and (from the
 * Inbox on) the switcher. These tests hold the two rules that make it safe to
 * add agents to later: ids are permanent, and identity never borrows the
 * status palette.
 */
describe('the agent registry', () => {
  it('every agent has a short mono mark, and no two share one', () => {
    const chips = AGENTS.map((a) => a.chip);
    expect(new Set(chips).size).toBe(chips.length);
    for (const agent of AGENTS) {
      expect(agent.chip.length).toBeGreaterThanOrEqual(2);
      expect(agent.chip.length).toBeLessThanOrEqual(3);
      // The mark is text. A colour or an image here would be identity competing
      // with the one thing colour is allowed to mean in this product.
      expect(agent.chip).toMatch(/^[A-Z]+$/);
    }
  });

  it('every agent says honestly what it costs, before you pick it', () => {
    for (const agent of AGENTS) {
      expect(agent.costNote.length).toBeGreaterThan(20);
    }
  });

  it('declared is not live — a picker may only offer what actually runs', () => {
    expect(liveAgentsFor('workshop').map((a) => a.id)).toEqual(['claude-code']);
    expect(liveAgentsFor('general')).toHaveLength(0);
    // ...while the roadmap stays visible to whoever needs to be honest about it.
    expect(agentsFor('workshop').map((a) => a.id)).toEqual(['claude-code', 'codex']);
    expect(agentsFor('general').map((a) => a.id)).toEqual(['claude', 'gpt']);
  });

  it('a builder never defaults into a chat thread, or the other way round', () => {
    expect(agentById(defaultAgentFor('workshop'))!.kinds).toContain('workshop');
    expect(agentById(defaultAgentFor('general'))!.kinds).toContain('general');
  });

  it('an id nobody declared is not an agent', () => {
    expect(isAgentId('claude-code')).toBe(true);
    expect(isAgentId('kimi')).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(agentById('kimi')).toBeNull();
  });

  it('the ids in use today are the ids stored in the database — renaming one orphans history', () => {
    expect(AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'claude', 'gpt']);
  });
});
