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
    // Stated as the rule rather than as a census: the point is that NOTHING is
    // filtered out, and a test that lists four names passes for the wrong
    // reason the moment a fifth agent is added and also filtered.
    expect(switchableAgents().map((a) => a.id)).toEqual(AGENTS.map((a) => a.id));
    expect(switchableAgents()).toHaveLength(AGENTS.length);
  });

  /**
   * Every agent here has a real path to a real model. `live` means WIRED, not
   * fuelled: an agent whose key nobody connected says exactly that when asked,
   * which is more useful than being hidden.
   */
  it('names what is coming without offering it', () => {
    // `live` used to be true for everything, so this asserted the empty set.
    // The flag exists precisely so a row can be declared before it is wired —
    // what matters is not that the set is empty but that anything in it is
    // OFFERED nowhere, which the roster enforces (test/web/roster.test.ts) and
    // a forced turn refuses (build/agent.ts).
    for (const agent of AGENTS.filter((a) => !a.live)) {
      // A declared row still has to be a complete row. Half a descriptor is
      // what turns "coming soon" into a crash the day somebody flips the flag.
      expect(agent.chip, agent.id).toMatch(/^[A-Z]{2,3}$/);
      expect(agent.costNote.length, agent.id).toBeGreaterThan(20);
      expect(agent.pricingModel.length, agent.id).toBeGreaterThan(2);
    }
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
    expect(isAgentId('kimi')).toBe(true);
    // Not a near-miss, not a provider name, not a plural. `xai` is a provider
    // — the company whose key you connect — and never an agent you can name.
    expect(isAgentId('xai')).toBe(false);
    expect(isAgentId('grok-4')).toBe(false);
    expect(isAgentId(null)).toBe(false);
    expect(agentById('xai')).toBeNull();
  });

  it('the ids in use today are the ids stored in the database — renaming one orphans history', () => {
    // Deliberately a census, unlike the test above: this one is the tripwire.
    // An id lands in threads.agent and in every message that quoted it, so it
    // may be ADDED here freely and never renamed. Updating this list is how a
    // rename gets noticed instead of shipped.
    expect(AGENTS.map((a) => a.id)).toEqual([
      'claude-code',
      'codex',
      'claude',
      'gpt',
      'gemini',
      'kimi',
      'grok',
      'deepseek',
      'mistral',
      'grok-build',
    ]);
  });

  /**
   * The seam that makes the roster growable: every agent burns SOME provider's
   * fuel, and that provider has to be one the fuel resolver can actually build
   * a client for. `shared/` cannot import `server/`, so the two lists are held
   * together here rather than by a type.
   */
  it('every live agent names a provider the fuel seam can actually reach', () => {
    const wired = new Set(['anthropic', 'openai', 'gemini', 'kimi', 'xai', 'deepseek', 'mistral']);
    for (const agent of AGENTS) {
      if (!agent.live) continue;
      expect(wired.has(agent.provider), `${agent.id} → ${agent.provider}`).toBe(true);
    }
  });

  /**
   * A builder is not a table row. It needs a CLI that runs in a sandbox and
   * reports what it did, so an agent added here as a talker must stay one
   * until that driver exists — otherwise the picker offers a build that
   * cannot happen.
   */
  it('only offers a builder where a sandbox driver exists for it', () => {
    // A builder needs four per-CLI things a table row cannot supply: an
    // install command, an exec command, and three parsers. So a builder may be
    // DECLARED ahead of its driver — and must not be live until the driver is
    // there, or the picker offers a build that cannot happen.
    const offered = AGENTS.filter((a) => a.changesFiles && a.live).map((a) => a.id);
    expect(offered).toEqual(['claude-code', 'codex']);
    expect(AGENTS.find((a) => a.id === 'grok-build')!.live).toBe(false);
  });
});
