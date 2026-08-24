import { describe, it, expect } from 'vitest';
import { cursorDbCandidates, parseComposer, parseLegacyChatData } from '../../src/cli/importers/cursor.js';

/**
 * The Cursor store is an undocumented format that has already shipped in at
 * least three layouts. What these hold is not "we understand Cursor" — nobody
 * outside Cursor can promise that — but that every layout we DO understand
 * parses, and everything else is counted with a reason instead of thrown or
 * silently skipped. The parser dying on row 900 of 1,000 imports nothing;
 * skipping row 900 silently reports a complete history that isn't.
 */
describe('reading Cursor chats out of the store', () => {
  it('reads the inline-conversation layout', () => {
    const raw = JSON.stringify({
      name: 'Fix the checkout flow',
      createdAt: 1755600000000,
      conversation: [
        { type: 1, text: 'why does the basket empty itself?' },
        { type: 2, text: 'The cart and checkout validate differently…' },
      ],
    });
    const { conversation, unreadable } = parseComposer('comp-1', raw, () => null);
    expect(unreadable).toEqual([]);
    expect(conversation).toMatchObject({
      sourceId: 'comp-1',
      title: 'Fix the checkout flow',
      messages: [
        { role: 'owner', content: 'why does the basket empty itself?' },
        { role: 'agent', content: 'The cart and checkout validate differently…' },
      ],
    });
    expect(conversation!.startedAt).toBe('2025-08-19T10:40:00.000Z');
  });

  it('reads the one-row-per-message layout through the bubble lookup, in header order', () => {
    const bubbles: Record<string, string> = {
      'b-2': JSON.stringify({ type: 2, text: 'second' }),
      'b-1': JSON.stringify({ type: 1, text: 'first' }),
    };
    const raw = JSON.stringify({
      name: 'Ordered',
      fullConversationHeadersOnly: [{ bubbleId: 'b-1' }, { bubbleId: 'b-2' }],
    });
    const { conversation } = parseComposer('comp-2', raw, (_c, b) => bubbles[b] ?? null);
    expect(conversation!.messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('counts a missing message row instead of inventing or dying', () => {
    const raw = JSON.stringify({ fullConversationHeadersOnly: [{ bubbleId: 'gone' }, { bubbleId: 'here' }] });
    const { conversation, unreadable } = parseComposer('comp-3', raw, (_c, b) =>
      b === 'here' ? JSON.stringify({ type: 1, text: 'still here' }) : null,
    );
    expect(conversation!.messages).toHaveLength(1);
    expect(unreadable).toEqual([{ ref: 'comp-3/gone', reason: 'message row missing from the store' }]);
  });

  it('an opened-and-abandoned composer is nothing, not an error', () => {
    const { conversation, unreadable } = parseComposer('comp-4', JSON.stringify({ name: 'Untitled' }), () => null);
    expect(conversation).toBeUndefined();
    expect(unreadable).toEqual([]);
  });

  it('a composer that is not JSON is one unreadable, with the reason', () => {
    const { conversation, unreadable } = parseComposer('comp-5', 'not-json{', () => null);
    expect(conversation).toBeUndefined();
    expect(unreadable[0]!.reason).toContain('not JSON');
  });

  it('never renders richText itself — a bubble with no flat text is left out rather than half-rebuilt', () => {
    const raw = JSON.stringify({
      conversation: [
        { type: 1, richText: '{"root":{"children":[]}}' },
        { type: 1, text: 'the real one' },
      ],
    });
    const { conversation } = parseComposer('comp-6', raw, () => null);
    expect(conversation!.messages.map((m) => m.content)).toEqual(['the real one']);
  });

  it('reads the legacy chat panel, tabs and string roles', () => {
    const raw = JSON.stringify({
      tabs: [
        { tabId: 'tab-9', chatTitle: 'Old chat', lastSendTime: 1700000000000, bubbles: [{ type: 'user', text: 'hello' }, { type: 'ai', text: 'hi' }] },
        { tabId: 'tab-empty', bubbles: [] },
      ],
    });
    const parsed = parseLegacyChatData(raw);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]).toMatchObject({ sourceId: 'legacy:tab-9', title: 'Old chat' });
  });

  it('knows where each platform keeps the store', () => {
    expect(cursorDbCandidates('/Users/g', 'darwin')[0]).toBe('/Users/g/Library/Application Support/Cursor/User/globalStorage/state.vscdb');
    expect(cursorDbCandidates('/home/g', 'linux')[0]).toBe('/home/g/.config/Cursor/User/globalStorage/state.vscdb');
  });
});
