import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseChatgptExport } from '../../src/server/import/consumer/chatgpt.js';
import { parseClaudeExport } from '../../src/server/import/consumer/claude.js';
import { parseGeminiExport } from '../../src/server/import/consumer/gemini.js';
import { importSummary, readExport, readExportZip } from '../../src/server/import/consumer/read.js';

/**
 * THE EXPORT PARSERS.
 *
 * What is being tested is mostly not "does it read a well-formed file" — it is
 * what happens to the parts that aren't well-formed. A history importer that
 * quietly drops what it can't parse produces the most confident wrong statement
 * in the product: "your history is in."
 */

describe('import/consumer — ChatGPT', () => {
  /** ChatGPT stores a node graph, because a message can be edited and branched. */
  function graph() {
    return {
      title: 'Curtain fabric weights',
      conversation_id: 'c1',
      create_time: 1_770_000_000,
      current_node: 'n3',
      mapping: {
        root: { id: 'root', parent: null, message: null },
        n1: { id: 'n1', parent: 'root', message: { author: { role: 'user' }, create_time: 1_770_000_001, content: { content_type: 'text', parts: ['which weight for a bay window?'] } } },
        n2: { id: 'n2', parent: 'n1', message: { author: { role: 'assistant' }, create_time: 1_770_000_002, content: { content_type: 'text', parts: ['Medium, usually.'] } } },
        n3: { id: 'n3', parent: 'n2', message: { author: { role: 'user' }, create_time: 1_770_000_003, content: { content_type: 'text', parts: ['and for a door?'] } } },
        // An abandoned branch: asked, then edited into n3 instead.
        n2b: { id: 'n2b', parent: 'n1', message: { author: { role: 'user' }, create_time: 1_770_000_009, content: { content_type: 'text', parts: ['ignore that'] } } },
      },
    };
  }

  it('walks the branch that survived, and leaves the abandoned one out', () => {
    const { conversations } = parseChatgptExport([graph()]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages.map((m) => m.content)).toEqual([
      'which weight for a bay window?',
      'Medium, usually.',
      'and for a door?',
    ]);
    // Not "ignore that", even though it is the newest thing in the file: a
    // transcript stitched from every branch is one that never happened.
    expect(conversations[0]!.messages.map((m) => m.content)).not.toContain('ignore that');
  });

  it('drops the plumbing: system turns, hidden nodes, and calls addressed to a tool', () => {
    const convo = graph();
    Object.assign(convo.mapping, {
      s1: { id: 's1', parent: 'root', message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['You are ChatGPT'] } } },
      h1: { id: 'h1', parent: 'n2', message: { author: { role: 'user' }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: 'text', parts: ['hidden context'] } } },
      t1: { id: 't1', parent: 'n2', message: { author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'text', parts: ['print(1)'] } } },
    });
    convo.current_node = 'n3';
    const all = parseChatgptExport([convo]).conversations[0]!.messages.map((m) => m.content).join('\n');
    expect(all).not.toMatch(/You are ChatGPT|hidden context|print\(1\)/);
  });

  it('REPORTS what it could not read instead of shrinking the list quietly', () => {
    const result = parseChatgptExport([graph(), { conversation_id: 'c2' }, 'not even an object', { conversation_id: 'c3', mapping: {} }]);
    expect(result.conversations).toHaveLength(1);
    expect(result.unreadable).toHaveLength(3);
    expect(result.unreadable.map((u) => u.ref)).toEqual(['c2', '#2', 'c3']);
    expect(result.unreadable[0]!.reason).toMatch(/no mapping/);
  });

  it('says what the format cannot carry, without being asked', () => {
    expect(parseChatgptExport([graph()]).limitations.join(' ')).toMatch(/abandoned|Images/);
  });

  it('refuses a date it cannot stand behind rather than inventing one', () => {
    const convo = graph();
    convo.create_time = 0;
    convo.mapping.n1.message!.create_time = -1 as unknown as number;
    const parsed = parseChatgptExport([convo]).conversations[0]!;
    expect(parsed.messages[0]!.at).toBeNull();
    // It falls back to the first message it could date, not to "now".
    expect(parsed.startedAt).toBe(new Date(1_770_000_002_000).toISOString());
  });

  it('survives a conversation with no current_node by taking the longest branch', () => {
    const convo = graph() as Record<string, unknown>;
    delete convo.current_node;
    const messages = parseChatgptExport([convo]).conversations[0]!.messages;
    expect(messages).toHaveLength(3);
  });
});

describe('import/consumer — Claude', () => {
  const convo = (over: Record<string, unknown> = {}) => ({
    uuid: 'u1',
    name: 'Pricing the made-to-measure line',
    created_at: '2026-02-03T09:00:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', created_at: '2026-02-03T09:00:00Z', text: 'what should we charge?' },
      { uuid: 'm2', sender: 'assistant', created_at: '2026-02-03T09:01:00Z', text: 'ignore me', content: [{ type: 'text', text: 'Cost plus forty.' }] },
    ],
    ...over,
  });

  it('prefers the content blocks over the older flat text', () => {
    const parsed = parseClaudeExport([convo()]).conversations[0]!;
    expect(parsed.messages.map((m) => m.content)).toEqual(['what should we charge?', 'Cost plus forty.']);
    expect(parsed.title).toBe('Pricing the made-to-measure line');
  });

  it('falls back to flat text for the older export shape', () => {
    const older = convo({ chat_messages: [{ sender: 'human', text: 'just the old field' }] });
    expect(parseClaudeExport([older]).conversations[0]!.messages[0]!.content).toBe('just the old field');
  });

  it('skips a turn that was all thinking or tool use, and reports a conversation left empty by it', () => {
    const thinkingOnly = convo({ uuid: 'u2', chat_messages: [{ sender: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }] });
    const result = parseClaudeExport([thinkingOnly]);
    expect(result.conversations).toHaveLength(0);
    expect(result.unreadable).toEqual([{ ref: 'u2', reason: 'nothing readable was said in it' }]);
  });
});

describe('import/consumer — Gemini', () => {
  const activity = [
    { header: 'Gemini Apps', title: 'Prompted how do I steam a linen curtain?', time: '2026-03-01T10:00:00Z' },
    { header: 'Gemini Apps', title: 'Used Gemini in Docs', time: '2026-03-01T10:05:00Z' },
    { header: 'Gemini Apps', time: '2026-03-01T10:06:00Z' },
  ];

  it('takes each recorded question on its own, because nothing says which belonged together', () => {
    const result = parseGeminiExport(activity);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.messages).toEqual([
      { role: 'owner', content: 'how do I steam a linen curtain?', at: '2026-03-01T10:00:00.000Z' },
    ]);
  });

  it('says out loud that the export has no answers in it', () => {
    expect(parseGeminiExport(activity).limitations.join(' ')).toMatch(/not what Gemini answered/);
  });

  it('reports the entries that are not questions rather than dropping them', () => {
    const { unreadable } = parseGeminiExport(activity);
    expect(unreadable).toHaveLength(2);
    expect(unreadable[0]!.reason).toMatch(/not a prompt/);
  });

  it('gives an entry an id stable across re-imports of the same file', () => {
    expect(parseGeminiExport(activity).conversations[0]!.sourceId).toBe(parseGeminiExport(activity).conversations[0]!.sourceId);
  });
});

describe('import/consumer — reading the archive', () => {
  const zip = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));

  it('tells Claude and ChatGPT apart by what is inside, not by the filename', () => {
    const chatgpt = readExportZip(zip({ 'conversations.json': JSON.stringify([{ conversation_id: 'c1', mapping: { a: { id: 'a', parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } } } }]) }));
    const claude = readExportZip(zip({ 'conversations.json': JSON.stringify([{ uuid: 'u1', chat_messages: [{ sender: 'human', text: 'hi' }] }]) }));
    expect(chatgpt.ok && chatgpt.vendor).toBe('chatgpt');
    expect(claude.ok && claude.vendor).toBe('claude');
  });

  it('finds the Gemini activity file wherever Takeout buried it', () => {
    const read = readExportZip(zip({ 'Takeout/My Activity/Gemini Apps/MyActivity.json': JSON.stringify([{ title: 'Prompted hello', time: '2026-03-01T10:00:00Z' }]) }));
    expect(read.ok && read.vendor).toBe('gemini');
  });

  it('says plainly when the archive holds nothing it knows how to read — and what it DID hold', () => {
    // Naming the contents is the difference between a dead end and a clue.
    // Without it somebody stares at a file they have no reason to doubt, which
    // is how an export manifest gets uploaded three times.
    const read = readExportZip(zip({ 'photos/cat.txt': 'meow', 'manifest-abc.json': '{}' }));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toMatch(/couldn't find a conversations.json/);
    expect(!read.ok && read.error).toContain('"cat.txt"');
    expect(!read.ok && read.error).toContain('"manifest-abc.json"');
    expect(!read.ok && read.error).toMatch(/manifest from the export email is not the export itself/);
  });

  it('does not pretend a non-ZIP is one', () => {
    const read = readExportZip(strToU8('this is not a zip file at all'));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toMatch(/couldn't open that as a ZIP/);
  });

  describe('a bare .json, because vendors hand one out', () => {
    // Refusing these taught people to zip the file themselves, which is the
    // one thing the archive error asks them not to do.
    it('reads an unzipped Claude export', () => {
      const read = readExport(strToU8(JSON.stringify([{ uuid: 'u1', chat_messages: [{ sender: 'human', text: 'hi' }] }])));
      expect(read.ok && read.vendor).toBe('claude');
    });

    it('reads an unzipped ChatGPT export', () => {
      const json = JSON.stringify([
        { conversation_id: 'c1', mapping: { a: { id: 'a', parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] } } } } },
      ]);
      expect(readExport(strToU8(json)).ok).toBe(true);
    });

    it('still reads an archive', () => {
      const read = readExport(zip({ 'conversations.json': JSON.stringify([{ uuid: 'u1', chat_messages: [{ sender: 'human', text: 'hi' }] }]) }));
      expect(read.ok && read.vendor).toBe('claude');
    });

    it('names the manifest problem instead of asking for a conversations.json again', () => {
      // The actual failure: a 1KB manifest-<uuid>.json from the export email,
      // uploaded because it was the only thing the download produced.
      const read = readExport(strToU8(JSON.stringify({ files: ['https://example.com/part-1'], expires: '2026-08-23' })));
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toMatch(/manifest from the export email/);
      expect(!read.ok && read.error).toMatch(/the real download is what it points at/);
    });

    it('refuses something that is neither', () => {
      const read = readExport(strToU8('hello, I am prose'));
      expect(read.ok).toBe(false);
      expect(!read.ok && read.error).toMatch(/isn't a ZIP archive or a JSON file/);
    });
  });

  it('never reports a success count without the failures beside it', () => {
    expect(importSummary('chatgpt', 1204, 0)).toMatch(/Nothing in the file was unreadable/);
    const mixed = importSummary('chatgpt', 1204, 300);
    expect(mixed).toContain('1204 conversations from ChatGPT');
    expect(mixed).toMatch(/300 entries in the file I could not read/);
    expect(mixed).toMatch(/they are not in/);
  });
});
