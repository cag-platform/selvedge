import { firstDated, isoFrom, tidy, type ImportedConversation, type ImportedMessage, type ParseResult, type UnreadableItem } from './types.js';

/**
 * ChatGPT's `conversations.json`.
 *
 * A conversation is not a list. It is a `mapping` of node id → node, each node
 * pointing at its parent, because the product supports editing a message and
 * branching from it. What a person means by "the conversation" is the path
 * from `current_node` back to the root — the branch that survived — and that
 * is what we walk. The abandoned branches are real history but they are not
 * what anyone remembers saying, and stitching them all together in timestamp
 * order would produce a transcript that never happened.
 *
 * System messages, tool calls, and the hidden context nodes are dropped: they
 * are OpenAI's plumbing, not the conversation.
 */

type Node = {
  id?: unknown;
  parent?: unknown;
  message?: {
    author?: { role?: unknown };
    create_time?: unknown;
    content?: { content_type?: unknown; parts?: unknown };
    /** ChatGPT marks its own scaffolding visually hidden. */
    metadata?: { is_visually_hidden_from_conversation?: unknown };
    recipient?: unknown;
  } | null;
};

function textOf(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const type = (content as { content_type?: unknown }).content_type;
  // Only plain text. An image or a code-interpreter payload is not something
  // we can honestly render as what was said.
  if (type !== undefined && type !== 'text' && type !== 'multimodal_text') return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((p): p is string => typeof p === 'string').join('\n').trim();
  return text === '' ? null : text;
}

/** The surviving branch, oldest first. */
function pathToRoot(mapping: Record<string, Node>, leaf: string): Node[] {
  const chain: Node[] = [];
  const seen = new Set<string>();
  let id: string | null = leaf;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node: Node | undefined = mapping[id];
    if (!node) break;
    chain.push(node);
    id = typeof node.parent === 'string' ? node.parent : null;
  }
  return chain.reverse();
}

/** The deepest leaf, for the exports where `current_node` is missing or dangling. */
function deepestLeaf(mapping: Record<string, Node>): string | null {
  const children = new Set<string>();
  for (const node of Object.values(mapping)) {
    if (typeof node.parent === 'string') children.add(node.parent);
  }
  let best: { id: string; depth: number } | null = null;
  for (const id of Object.keys(mapping)) {
    if (children.has(id)) continue;
    const depth = pathToRoot(mapping, id).length;
    if (!best || depth > best.depth) best = { id, depth };
  }
  return best?.id ?? null;
}

function parseOne(raw: unknown, index: number): ImportedConversation | UnreadableItem {
  if (!raw || typeof raw !== 'object') return { ref: `#${index}`, reason: 'not an object' };
  const convo = raw as Record<string, unknown>;
  const sourceId = typeof convo.conversation_id === 'string' ? convo.conversation_id : typeof convo.id === 'string' ? convo.id : `#${index}`;
  const mapping = convo.mapping;
  if (!mapping || typeof mapping !== 'object') return { ref: sourceId, reason: 'no mapping — not a conversation this version of the export writes' };

  const nodes = mapping as Record<string, Node>;
  const current = typeof convo.current_node === 'string' && nodes[convo.current_node] ? convo.current_node : deepestLeaf(nodes);
  if (!current) return { ref: sourceId, reason: 'empty conversation' };

  const messages: ImportedMessage[] = [];
  for (const node of pathToRoot(nodes, current)) {
    const message = node.message;
    if (!message) continue;
    if (message.metadata?.is_visually_hidden_from_conversation === true) continue;
    const role = message.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    // An assistant turn addressed to a tool is a tool call, not a reply.
    if (role === 'assistant' && typeof message.recipient === 'string' && message.recipient !== 'all') continue;
    const text = textOf(message.content);
    if (text === null) continue;
    messages.push({ role: role === 'user' ? 'owner' : 'agent', content: tidy(text), at: isoFrom(message.create_time) });
  }

  if (messages.length === 0) return { ref: sourceId, reason: 'nothing readable was said in it' };
  return {
    sourceId,
    title: typeof convo.title === 'string' && convo.title.trim() !== '' ? convo.title.trim().slice(0, 120) : 'Untitled chat',
    startedAt: isoFrom(convo.create_time) ?? firstDated(messages),
    messages,
  };
}

export function parseChatgptExport(json: unknown): ParseResult {
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
    limitations: [
      'Only the version of each chat you kept is imported — if you edited a message and branched, the branches you abandoned are not here.',
      'Images, files and code-interpreter output are not imported; the words around them are.',
    ],
  };
}
