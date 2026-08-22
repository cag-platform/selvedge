import { describe, it, expect } from 'vitest';
import { AGENTS, agentById, changesFiles, isAgentId, startingAgentFor, switchableAgents } from '../../src/shared/agents.js';

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

  /**
   * The picker offers everybody. There used to be a filter keyed on the kind
   * of thread you were in, and it decided who could answer before anyone knew
   * what the conversation was about — which is exactly backwards.
   */
  it('offers the whole roster, whatever the conversation is', () => {
    expect(switchableAgents().map((a) => a.id)).toEqual(['claude-code', 'codex', 'claude', 'gpt']);
  });

  /**
   * Every agent here has a real path to a real model. `live` means WIRED, not
   * fuelled: an agent whose key nobody connected says exactly that when asked,
   * which is more useful than being hidden.
   */
  it('offers nothing it cannot actually run', () => {
    expect(AGENTS.filter((a) => !a.live)).toEqual([]);
  });

  it('says what each one does, which is the only difference that matters', () => {
    expect(changesFiles('claude-code')).toBe(true);
    expect(changesFiles('codex')).toBe(true);
    expect(changesFiles('claude')).toBe(false);
    expect(changesFiles('gpt')).toBe(false);
    expect(changesFiles('nobody')).toBe(false);
  });

  /**
   * Where a conversation starts still follows what was asked for. That was
   * never the wall — the wall was refusing to let it move afterwards.
   */
  it('starts a build conversation on a builder, and everything else on a talker', () => {
    expect(changesFiles(startingAgentFor('workshop'))).toBe(true);
    expect(changesFiles(startingAgentFor('general'))).toBe(false);
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
