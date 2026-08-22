import { describe, it, expect } from 'vitest';
import { mentionedAgents, mentionIntent, consultationLine, MAX_CONSULTED } from '../../src/shared/mentions.js';
import { agentById } from '../../src/shared/agents.js';

describe('@-mentions — who was asked', () => {
  it('reads a name out of the sentence it was written in', () => {
    expect(mentionedAgents('@claudecode ok build it')).toEqual(['claude-code']);
  });

  it('takes the name however it was typed', () => {
    expect(mentionedAgents('@claude-code go')).toEqual(['claude-code']);
    expect(mentionedAgents('@ClaudeCode go')).toEqual(['claude-code']);
    expect(mentionedAgents('@CLAUDE_CODE go')).toEqual(['claude-code']);
  });

  /**
   * The collision that would be a silent, expensive bug: `claude` is a prefix
   * of `claude-code`, so a prefix match would send a cheap chat turn into a
   * sandbox — or worse, the other way.
   */
  it('does not confuse @claude with @claudecode', () => {
    expect(mentionedAgents('@claude what do you think?')).toEqual(['claude']);
    expect(mentionedAgents('@claudecode what do you think?')).toEqual(['claude-code']);
  });

  it('keeps the order they were named in, and never repeats one', () => {
    expect(mentionedAgents('@codex @claudecode @codex your takes')).toEqual(['codex', 'claude-code']);
  });

  it('ignores an @ that is part of a word — an address is not a request', () => {
    expect(mentionedAgents('mail greg@claude.example about it')).toEqual([]);
    expect(mentionedAgents('the css has @claude in it somehow')).toEqual(['claude']);
  });

  it('ignores names it does not recognise rather than refusing the message', () => {
    expect(mentionedAgents('@nobody @gpt hello')).toEqual(['gpt']);
    expect(mentionedAgents('ping @everyone')).toEqual([]);
  });

  it('finds a name anywhere in the message, not only at the front', () => {
    expect(mentionedAgents('this is ready now @claudecode')).toEqual(['claude-code']);
  });

  /** The text is the record. Nothing is stripped, rewritten or tidied. */
  it('reads the message without changing it', () => {
    const text = '@claudecode ok build it';
    mentionedAgents(text);
    expect(text).toBe('@claudecode ok build it');
  });
});

describe('what the mentions ask for', () => {
  it('no name means whoever answered last carries on', () => {
    expect(mentionIntent('now make it darker')).toEqual({ kind: 'continue' });
  });

  it('one name directs the turn — and hands the conversation over', () => {
    expect(mentionIntent('@claudecode ok build it')).toEqual({ kind: 'direct', agent: 'claude-code' });
  });

  /**
   * Asking two people what they think is not handing the work to either of
   * them, so a consultation is its own shape rather than two switches.
   */
  it('two names is a consultation, not a handover', () => {
    expect(mentionIntent('@codex @claudecode i want to see your takes on this')).toEqual({
      kind: 'consult',
      agents: ['codex', 'claude-code'],
    });
  });

  it('caps how many can be asked at once, because every one of them spends', () => {
    expect(MAX_CONSULTED).toBeGreaterThan(1);
    expect(MAX_CONSULTED).toBeLessThan(5);
  });
});

describe('the line a consultation leaves behind', () => {
  const name = (id: 'claude-code' | 'codex' | 'claude' | 'gpt') => agentById(id)!.name;

  it('says who was asked, and says outright that nothing was built', () => {
    const line = consultationLine(['codex', 'claude-code'], name);
    expect(line).toContain('Codex and Claude Code');
    expect(line).toContain('nothing was built');
  });

  it('reads as a sentence with three of them', () => {
    expect(consultationLine(['claude', 'gpt', 'codex'], name)).toContain('Claude, GPT and Codex');
  });
});
