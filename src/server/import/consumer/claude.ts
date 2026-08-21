import { firstDated, isoFrom, tidy, type ImportedConversation, type ImportedMessage, type ParseResult, type UnreadableItem } from './types.js';

/**
 * Claude's `conversations.json`.
 *
 * Flatter than ChatGPT's: a list of conversations, each with `chat_messages`
 * in order. Two shapes for the text itself, and both are in the wild — an
 * older `text` string, and a newer `content` array of typed blocks. Read both;
 * prefer the blocks when they are there, because `text` on those exports is a
 * lossy summary of them.
 */

type Block = { type?: unknown; text?: unknown };
type Message = {
  uuid?: unknown;
  sender?: unknown;
  text?: unknown;
  content?: unknown;
  created_at?: unknown;
};

function textOf(message: Message): string | null {
  if (Array.isArray(message.content)) {
    const text = (message.content as Block[])
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => String(b.text))
      .join('\n')
      .trim();
    if (text !== '') return text;
    // Blocks that are all thinking/tool_use carry no words that were said.
    if ((message.content as Block[]).length > 0 && typeof message.text !== 'string') return null;
  }
  if (typeof message.text === 'string' && message.text.trim() !== '') return message.text.trim();
  return null;
}

function parseOne(raw: unknown, index: number): ImportedConversation | UnreadableItem {
  if (!raw || typeof raw !== 'object') return { ref: `#${index}`, reason: 'not an object' };
  const convo = raw as Record<string, unknown>;
  const sourceId = typeof convo.uuid === 'string' ? convo.uuid : `#${index}`;
  const list = convo.chat_messages;
  if (!Array.isArray(list)) return { ref: sourceId, reason: 'no chat_messages — not a conversation this version of the export writes' };

  const messages: ImportedMessage[] = [];
  for (const raw of list as Message[]) {
    if (!raw || typeof raw !== 'object') continue;
    const sender = raw.sender;
    if (sender !== 'human' && sender !== 'assistant') continue;
    const text = textOf(raw);
    if (text === null) continue;
    messages.push({ role: sender === 'human' ? 'owner' : 'agent', content: tidy(text), at: isoFrom(raw.created_at) });
  }

  if (messages.length === 0) return { ref: sourceId, reason: 'nothing readable was said in it' };
  const name = typeof convo.name === 'string' ? convo.name.trim() : '';
  return {
    sourceId,
    title: name !== '' ? name.slice(0, 120) : 'Untitled chat',
    startedAt: isoFrom(convo.created_at) ?? firstDated(messages),
    messages,
  };
}

export function parseClaudeExport(json: unknown): ParseResult {
  if (!Array.isArray(json)) {
    return { conversations: [], unreadable: [{ ref: 'conversations.json', reason: 'the file is not a list of conversations' }], limitations: [] };
  }
  const conversations: ImportedConversation[] = [];
  const unreadable: UnreadableItem[] = [];
  json.forEach((raw, i) => {
    const result = parseOne(raw, i);
    if ('reason' in result) unreadable.push(result);
    else conversations.push(result);
  });
  return {
    conversations,
    unreadable,
    limitations: ['Attachments and artifacts are not imported; the conversation around them is.'],
  };
}
