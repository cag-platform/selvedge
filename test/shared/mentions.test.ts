import { describe, it, expect } from 'vitest';
import { mentionedAgents, mentionIntent, consultationLine, MAX_CONSULTED } from '../../src/shared/mentions.js';
import { agentById, AGENTS } from '../../src/shared/agents.js';

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

/**
 * THE ROOM GOT BIGGER.
 *
 * Five talkers arrived as five table rows, and the only thing that could
 * silently break is the parse: a name that doesn't resolve isn't an error, it
 * is a message that quietly answers as somebody else.
 */
describe('naming any of the models in the room', () => {
  it('resolves every agent in the registry by its own id', () => {
    for (const agent of AGENTS) {
      const intent = mentionIntent(`@${agent.id.replace(/-/g, '')} what do you think?`);
      expect(intent, agent.id).toEqual({ kind: 'direct', agent: agent.id });
    }
  });

  it('tells the near-misses apart', () => {
    // The reason matching is exact-on-normalised rather than by prefix: these
    // pairs share an opening and mean different things, and "closest match"
    // would hand a build to a talker.
    expect(mentionIntent('@claude go')).toEqual({ kind: 'direct', agent: 'claude' });
    expect(mentionIntent('@claudecode go')).toEqual({ kind: 'direct', agent: 'claude-code' });
    expect(mentionIntent('@gpt go')).toEqual({ kind: 'direct', agent: 'gpt' });
    // A provider is not an agent. `xai` is the key you connect; `grok` is who
    // you talk to. An unrecognised name doesn't refuse the message — it just
    // isn't a handover, so whoever is answering carries on.
    expect(mentionIntent('@xai go')).toEqual({ kind: 'continue' });
    expect(mentionIntent('@moonshot go')).toEqual({ kind: 'continue' });
  });

  it('lets the new ones join a consultation', () => {
    const intent = mentionIntent('@kimi @gemini @grok which of these is cheapest to run?');
    expect(intent.kind).toBe('consult');
    if (intent.kind !== 'consult') return;
    expect(intent.agents).toEqual(['kimi', 'gemini', 'grok']);
  });

  /**
   * The parse reports everyone named; the CAP is applied where the spending
   * happens (routes/threads.ts), which is also where what got left out is now
   * said out loud. Naming six and hearing from three in silence was survivable
   * at four agents and is not at nine.
   */
  it('reports everyone named, and the line says who did not fit', () => {
    const intent = mentionIntent('@claude @gpt @kimi @gemini @grok @mistral thoughts?');
    expect(intent.kind).toBe('consult');
    if (intent.kind !== 'consult') return;
    expect(intent.agents).toHaveLength(6);

    const asked = intent.agents.slice(0, MAX_CONSULTED);
    const skipped = intent.agents.slice(MAX_CONSULTED);
    const line = consultationLine(asked, (id) => agentById(id)?.name ?? id, skipped);
    expect(line).toContain('Gemini');
    expect(line).toContain('the limit');
    // And with nobody left out, the line says nothing about a limit.
    expect(consultationLine(asked, (id) => agentById(id)?.name ?? id)).not.toContain('limit');
  });
});
