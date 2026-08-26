import { describe, expect, it } from 'vitest';
import { groupPairedConsultations } from '../../src/client/lib/consultation.js';
import type { ThreadMessage } from '../../src/client/lib/inbox.js';

function message(
  id: string,
  role: ThreadMessage['role'],
  options: Partial<Pick<ThreadMessage, 'answered_by' | 'consultation_id' | 'in_reply_to' | 'meta'>> = {},
): ThreadMessage {
  return {
    id,
    role,
    content: id,
    at: `2026-08-25T00:00:0${id.length}.000Z`,
    attachments: [],
    ...options,
  };
}

describe('paired consultations in a chronological thread', () => {
  const consultationId = 'consultation-1';
  const owner = message('owner', 'owner', { consultation_id: consultationId });
  const marker = message('marker', 'switch', {
    consultation_id: consultationId,
    meta: {
      consulted: ['claude-code', 'codex'],
      consultation_id: consultationId,
      consultation: { id: consultationId, prompt_id: owner.id, agents: ['claude-code', 'codex'] },
    },
  });
  const claude = message('claude', 'agent', {
    answered_by: 'claude-code',
    consultation_id: consultationId,
    in_reply_to: owner.id,
  });
  const codex = message('codex', 'agent', {
    answered_by: 'codex',
    consultation_id: consultationId,
    in_reply_to: owner.id,
  });

  it('groups two signed answers only when the structured consultation marker proves the pair', () => {
    const items = groupPairedConsultations([owner, marker, codex, claude]);

    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'comparison']);
    const comparison = items[2];
    expect(comparison?.kind).toBe('comparison');
    if (comparison?.kind !== 'comparison') return;
    expect(comparison.prompt).toBe(owner);
    expect(comparison.marker).toBe(marker);
    expect(comparison.agents).toEqual(['claude-code', 'codex']);
    // Network arrival cannot make the cards trade places between polls.
    expect(comparison.answers.map((answer) => answer.id)).toEqual(['claude', 'codex']);
  });

  it('leaves ordinary adjacent answers in their original sequential order', () => {
    const items = groupPairedConsultations([owner, claude, codex]);
    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'message']);
    expect(items.map((item) => item.kind === 'message' ? item.message.id : '')).toEqual(['owner', 'claude', 'codex']);
  });

  it.each([
    {
      name: 'only one answer has arrived',
      messages: [owner, marker, claude],
    },
    {
      name: 'an answer is unsigned',
      messages: [owner, marker, claude, message('unsigned', 'agent', { consultation_id: consultationId, in_reply_to: owner.id })],
    },
    {
      name: 'the same agent answered twice',
      messages: [owner, marker, claude, message('duplicate', 'agent', {
        answered_by: 'claude-code',
        consultation_id: consultationId,
        in_reply_to: owner.id,
      })],
    },
    {
      name: 'the marker names three agents',
      messages: [owner, message('panel', 'switch', {
        consultation_id: consultationId,
        meta: {
          consulted: ['claude-code', 'codex', 'gpt'],
          consultation_id: consultationId,
          consultation: { id: consultationId, prompt_id: owner.id, agents: ['claude-code', 'codex', 'gpt'] },
        },
      }), claude, codex],
    },
    {
      name: 'one answer came from somebody else',
      messages: [owner, marker, claude, message('gpt', 'agent', {
        answered_by: 'gpt',
        consultation_id: consultationId,
        in_reply_to: owner.id,
      })],
    },
    {
      name: 'the request was capped beyond the pair',
      messages: [owner, message('capped', 'switch', {
        consultation_id: consultationId,
        meta: {
          consulted: ['claude-code', 'codex'],
          skipped: ['gpt'],
          consultation_id: consultationId,
          consultation: { id: consultationId, prompt_id: owner.id, agents: ['claude-code', 'codex'] },
        },
      }), claude, codex],
    },
    {
      name: 'legacy rows have no correlation',
      messages: [
        message('legacy-owner', 'owner'),
        message('legacy-marker', 'switch', { meta: { consulted: ['claude-code', 'codex'] } }),
        message('legacy-claude', 'agent', { answered_by: 'claude-code' }),
        message('legacy-codex', 'agent', { answered_by: 'codex' }),
      ],
    },
  ])('does not infer a comparison when $name', ({ messages }) => {
    expect(groupPairedConsultations(messages).every((item) => item.kind === 'message')).toBe(true);
  });

  it('keeps a correlated reference note in sequence and still compares the two replies', () => {
    const reference = message('reference', 'switch', {
      consultation_id: consultationId,
      in_reply_to: owner.id,
    });
    const items = groupPairedConsultations([owner, marker, reference, claude, codex]);

    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'comparison']);
    expect(items[2]?.kind === 'message' ? items[2].message : null).toBe(reference);
  });

  it('keeps a builder activity envelope visible while comparing the final chat and build replies', () => {
    const activity = message('activity', 'activity', {
      consultation_id: consultationId,
      in_reply_to: owner.id,
    });
    const items = groupPairedConsultations([owner, marker, claude, activity, codex]);

    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'comparison']);
    expect(items[2]?.kind === 'message' ? items[2].message : null).toBe(activity);
    expect(items[3]?.kind === 'comparison' ? items[3].answers.map((answer) => answer.id) : []).toEqual(['claude', 'codex']);
  });

  it('does not borrow a late reply from an overlapping consultation with the same agents', () => {
    const secondId = 'consultation-2';
    const secondOwner = message('owner-2', 'owner', { consultation_id: secondId });
    const secondMarker = message('marker-2', 'switch', {
      consultation_id: secondId,
      meta: {
        consulted: ['claude-code', 'codex'],
        consultation_id: secondId,
        consultation: { id: secondId, prompt_id: secondOwner.id, agents: ['claude-code', 'codex'] },
      },
    });
    const secondClaude = message('claude-2', 'agent', {
      answered_by: 'claude-code',
      consultation_id: secondId,
      in_reply_to: secondOwner.id,
    });
    const secondCodex = message('codex-2', 'agent', {
      answered_by: 'codex',
      consultation_id: secondId,
      in_reply_to: secondOwner.id,
    });

    const items = groupPairedConsultations([
      owner,
      marker,
      claude,
      secondOwner,
      secondMarker,
      codex, // late answer from the first consultation
      secondClaude,
      secondCodex,
    ]);

    expect(items.every((item) => item.kind === 'message')).toBe(true);
  });

  it('rejects a duplicate correlated answer instead of hiding it inside a pair', () => {
    const duplicate = message('codex-duplicate', 'agent', {
      answered_by: 'codex',
      consultation_id: consultationId,
      in_reply_to: owner.id,
    });
    expect(groupPairedConsultations([owner, marker, claude, codex, duplicate]).every((item) => item.kind === 'message')).toBe(true);
  });
});
