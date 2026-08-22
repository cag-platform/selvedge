import { describe, it, expect } from 'vitest';
import { mentionQuery, offersMatching, completeMention, sendNote, answering, type AgentOffer } from '../../src/client/lib/agents.js';

/** A roster in the shape the server sends one. */
function offer(over: Partial<AgentOffer> & Pick<AgentOffer, 'id' | 'name'>): AgentOffer {
  return {
    chip: over.name.slice(0, 2).toUpperCase(),
    changes_files: false,
    does: "Talks it through. Doesn't touch your files.",
    cost_note: 'a fraction of what a build turn costs',
    answering_now: false,
    available: true,
    unavailable_note: null,
    handoff: { tokens: 0, cost_usd: null, note: 'switching is free' },
    ...over,
  } as AgentOffer;
}

const roster: AgentOffer[] = [
  offer({
    id: 'claude-code',
    name: 'Claude Code',
    changes_files: true,
    does: 'Changes files in your sandbox.',
    handoff: { tokens: 1842, cost_usd: 0.02, note: 'switching costs about $0.02 · carries 1.8k tokens over' },
  }),
  offer({ id: 'codex', name: 'Codex', changes_files: true, available: false, unavailable_note: 'Codex builds on an OpenAI key, and there isn’t one configured here yet.' }),
  offer({ id: 'claude', name: 'Claude', answering_now: true, handoff: null }),
  offer({ id: 'gpt', name: 'GPT' }),
];

describe('the mention the caret is inside', () => {
  it('is the half-typed name at the end, and nothing else', () => {
    expect(mentionQuery('@clau')).toBe('clau');
    expect(mentionQuery('ok now @codex')).toBe('codex');
  });

  /** `@` alone means "show me everyone" — how the roster gets discovered. */
  it('treats a bare @ as a request for the whole roster', () => {
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('right, @')).toBe('');
  });

  it('closes once the name is finished and the sentence carries on', () => {
    expect(mentionQuery('@claudecode ok build it')).toBeNull();
    expect(mentionQuery('nothing here')).toBeNull();
  });

  it('is not opened by an address', () => {
    expect(mentionQuery('mail greg@smithbespoke.com')).toBeNull();
  });
});

describe('narrowing the roster as you type', () => {
  it('matches on the id or the name, however it is punctuated', () => {
    expect(offersMatching(roster, 'clau').map((a) => a.id)).toEqual(['claude-code', 'claude']);
    expect(offersMatching(roster, 'claude-c').map((a) => a.id)).toEqual(['claude-code']);
    expect(offersMatching(roster, 'g').map((a) => a.id)).toEqual(['gpt']);
  });

  it('shows everyone for a bare @', () => {
    expect(offersMatching(roster, '')).toHaveLength(4);
  });
});

describe('completing a mention', () => {
  it('finishes the name and leaves the caret ready to keep typing', () => {
    expect(completeMention('@clau', 'claude-code')).toBe('@claude-code ');
    expect(completeMention('ok now @co', 'codex')).toBe('ok now @codex ');
    expect(completeMention('@', 'gpt')).toBe('@gpt ');
  });
});

describe('what pressing send is about to cost', () => {
  it('says nothing when nobody is named', () => {
    expect(sendNote('now make it darker', roster)).toBeNull();
  });

  /** Naming whoever is already answering costs nothing and needs no announcement. */
  it('says nothing when the name is the one already answering', () => {
    expect(sendNote('@claude what do you think?', roster)).toBeNull();
  });

  /**
   * THE RULE THE PICKER USED TO BREAK: the price arrives before the decision,
   * not after it.
   */
  it('prices a handover before it is taken', () => {
    const note = sendNote('@claudecode ok build it', roster);
    expect(note).toContain('Claude Code');
    expect(note).toContain('$0.02');
    expect(note).toContain('1.8k tokens');
  });

  it('says a free handover is free', () => {
    expect(sendNote('@gpt thoughts?', roster)).toBe('Handing over to GPT — switching is free');
  });

  /** An agent that can't run says why, instead of failing after send. */
  it('says what is missing rather than letting the send fail', () => {
    expect(sendNote('@codex build it', roster)).toMatch(/OpenAI key/i);
  });

  it('counts the turns a consultation will take, and promises no building', () => {
    const note = sendNote('@codex @claudecode your takes?', roster);
    expect(note).toContain('Codex and Claude Code');
    expect(note).toContain('2 turns');
    expect(note).toContain('nothing gets built');
  });

  it('says out loud when more were named than will be asked', () => {
    const note = sendNote('@claude @gpt @codex @claudecode everyone', roster);
    expect(note).toContain('1 more named than I’ll ask at once'.replace('’', "'"));
  });
});

describe('who is answering', () => {
  it('is the one the roster says it is', () => {
    expect(answering(roster)?.id).toBe('claude');
    expect(answering([])).toBeNull();
  });
});
