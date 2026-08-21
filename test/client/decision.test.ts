import { describe, it, expect } from 'vitest';
import { datingLine, hasBrief, staleRefusalOf, type DatedBrief } from '../../src/client/lib/decision.js';

/**
 * The client's half of the dating rule: whatever the panel does with it, the
 * sentence a person reads has to say both what the decision was written from
 * and what has happened since. Neither half alone is honest — "3 messages
 * since" means nothing without knowing it saw twelve, and "written from twelve"
 * reads as settled when three have landed on top of it.
 */

function dated(over: Partial<DatedBrief['brief']> = {}, freshness: Partial<DatedBrief['freshness']> = {}): DatedBrief {
  return {
    brief: {
      id: 'b1',
      title: 'One-page checkout',
      decision: 'Make it one page.',
      why: null,
      constraints: [],
      openQuestions: [],
      projectId: 'loom',
      thinkingThreadId: 't1',
      buildingThreadId: null,
      editedByHuman: false,
      evidenceThrough: '2026-08-01T10:00:00Z',
      evidenceMessages: 12,
      ...over,
    },
    freshness: { state: 'current', behind: 0, note: '', ...freshness },
    thinkingMessages: 12,
  };
}

describe('client/lib/decision', () => {
  it('says what it was written from AND what has been said since', () => {
    expect(datingLine(dated())).toBe('Written from 12 messages of the thinking · nothing said since');
    expect(datingLine(dated({}, { state: 'stale', behind: 3 }))).toBe('Written from 12 messages of the thinking · 3 said since');
  });

  it('a brief made from nothing says so rather than reading as current', () => {
    expect(datingLine(dated({ evidenceMessages: 0, evidenceThrough: null }))).toMatch(/^Written from nothing on the record/);
  });

  it('counts one message in the singular, because the line is read by a person', () => {
    expect(datingLine(dated({ evidenceMessages: 1 }))).toContain('1 message of the thinking');
  });

  it('hasBrief narrows a nothing-decided-yet response away', () => {
    expect(hasBrief(null)).toBe(false);
    expect(hasBrief({ brief: null })).toBe(false);
    expect(hasBrief(dated())).toBe(true);
  });

  it('reads the stale refusal off a 409, and refuses to invent one from a different error', () => {
    expect(staleRefusalOf({ stale_decision: { brief_id: 'b1', behind: 2, thinking_thread_id: 't1' } })).toEqual({
      brief_id: 'b1',
      behind: 2,
      thinking_thread_id: 't1',
    });
    // A 409 from somewhere else entirely must not turn into a stale banner
    // offering to build from a decision that isn't the reason it failed.
    expect(staleRefusalOf({ error: 'no model key connected' })).toBeNull();
    expect(staleRefusalOf({ stale_decision: { behind: 2 } })).toBeNull();
  });
});
