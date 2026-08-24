import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * READING CURSOR'S CHATS OUT OF THE FILE THEY ACTUALLY LIVE IN.
 *
 * Cursor has no export. The history sits in a SQLite file
 * (`User/globalStorage/state.vscdb`) in two undocumented layouts that have
 * both shipped to real machines:
 *
 *   - the composer layout: `cursorDiskKV` rows keyed `composerData:{id}` for
 *     each conversation, with the messages either inline (older) or as one
 *     `bubbleId:{composerId}:{bubbleId}` row per message (newer), ordered by
 *     the composer's `fullConversationHeadersOnly`;
 *   - the legacy chat panel: one `ItemTable` row under
 *     `workbench.panel.aichat.view.aichat.chatdata`, tabs with bubbles.
 *
 * UNDOCUMENTED MEANS DEFENSIVE. Every shape assumption here is a guess about
 * somebody else's private format, so nothing throws: what doesn't parse is
 * returned as an unreadable with a reason, and the summary the owner sees
 * counts it. A parser that dies on row 900 of 1,000 imports nothing; one that
 * skips row 900 SILENTLY is worse — it reports a complete history that isn't.
 *
 * The parsing is pure functions over plain values, because the format is the
 * risky part and the tests need to hold it without a SQLite file in the repo.
 */

export type CursorMessage = { role: 'owner' | 'agent'; content: string; at: string | null };
export type CursorConversation = { sourceId: string; title: string; startedAt: string | null; messages: CursorMessage[] };
export type Unreadable = { ref: string; reason: string };
export type CursorParse = { conversations: CursorConversation[]; unreadable: Unreadable[] };

/** Where Cursor keeps the global store, per platform. First hit wins. */
export function cursorDbCandidates(home = homedir(), platform = process.platform): string[] {
  const tail = ['Cursor', 'User', 'globalStorage', 'state.vscdb'];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', ...tail)];
  if (platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return [path.join(appdata, ...tail)];
  }
  return [path.join(home, '.config', ...tail)];
}

export function findCursorDb(): string | null {
  return cursorDbCandidates().find((p) => existsSync(p)) ?? null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function json(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** Epoch millis, epoch seconds, or ISO — Cursor has used all three. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v > 10_000_000_000 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** A bubble's text, wherever this Cursor version put it. */
function bubbleText(b: Record<string, unknown>): string {
  if (typeof b.text === 'string' && b.text.trim() !== '') return b.text;
  // richText is a serialized editor document; `text` is the flat rendering
  // Cursor keeps beside it. When only richText exists we do NOT attempt to
  // reassemble it — a half-rendered document pretending to be the message is
  // the silent-truncation lie. The bubble is reported unreadable instead.
  return '';
}

/** 1 = the person, 2 = the model — the composer layout's enum. */
function bubbleRole(b: Record<string, unknown>): 'owner' | 'agent' | null {
  if (b.type === 1 || b.type === 'user') return 'owner';
  if (b.type === 2 || b.type === 'ai' || b.type === 'assistant') return 'agent';
  return null;
}

/**
 * One composer row → one conversation. `getBubble` resolves the newer
 * one-row-per-message layout; inline `conversation` arrays are read directly.
 */
export function parseComposer(
  composerId: string,
  raw: unknown,
  getBubble: (composerId: string, bubbleId: string) => unknown,
): { conversation?: CursorConversation; unreadable: Unreadable[] } {
  const unreadable: Unreadable[] = [];
  const data = asObject(json(raw));
  if (!data) return { unreadable: [{ ref: composerId, reason: 'composer row was not JSON I could read' }] };

  const title =
    (typeof data.name === 'string' && data.name.trim() !== '' ? data.name : '').slice(0, 200) || `Cursor chat ${composerId.slice(0, 8)}`;
  const startedAt = toIso(data.createdAt);

  // Where the messages are depends on the era: inline array first, then the
  // headers-plus-bubble-rows layout.
  let bubbles: unknown[] = [];
  if (Array.isArray(data.conversation) && data.conversation.length > 0) {
    bubbles = data.conversation;
  } else if (Array.isArray(data.fullConversationHeadersOnly)) {
    for (const h of data.fullConversationHeadersOnly) {
      const header = asObject(h);
      const bubbleId = header && typeof header.bubbleId === 'string' ? header.bubbleId : null;
      if (!bubbleId) {
        unreadable.push({ ref: composerId, reason: 'a message header had no id' });
        continue;
      }
      const bubble = json(getBubble(composerId, bubbleId));
      if (bubble === null || bubble === undefined) {
        unreadable.push({ ref: `${composerId}/${bubbleId}`, reason: 'message row missing from the store' });
        continue;
      }
      bubbles.push(bubble);
    }
  }

  const messages: CursorMessage[] = [];
  for (const raw of bubbles) {
    const b = asObject(raw);
    if (!b) continue;
    const role = bubbleRole(b);
    const content = bubbleText(b);
    if (!role || content.trim() === '') continue; // tool noise, thinking blocks, richText-only — not a said thing we can carry
    messages.push({ role, content, at: toIso(b.createdAt ?? b.timestamp) });
  }

  if (messages.length === 0) {
    // An empty composer is common (opened and abandoned) — that is not an
    // error worth a line. One that HAD headers but yielded nothing is.
    if (bubbles.length > 0 || (Array.isArray(data.fullConversationHeadersOnly) && data.fullConversationHeadersOnly.length > 0)) {
      unreadable.push({ ref: composerId, reason: 'had messages but none in a shape I could read' });
    }
    return { unreadable };
  }

  return { conversation: { sourceId: composerId, title, startedAt, messages }, unreadable };
}

/** The pre-composer chat panel: one JSON blob, tabs of bubbles. */
export function parseLegacyChatData(raw: unknown): CursorParse {
  const conversations: CursorConversation[] = [];
  const unreadable: Unreadable[] = [];
  const data = asObject(json(raw));
  if (!data || !Array.isArray(data.tabs)) return { conversations, unreadable };

  for (const [i, t] of data.tabs.entries()) {
    const tab = asObject(t);
    if (!tab) {
      unreadable.push({ ref: `legacy tab #${i}`, reason: 'not a shape I could read' });
      continue;
    }
    const sourceId = typeof tab.tabId === 'string' && tab.tabId !== '' ? `legacy:${tab.tabId}` : `legacy:#${i}`;
    const messages: CursorMessage[] = [];
    for (const b of Array.isArray(tab.bubbles) ? tab.bubbles : []) {
      const bubble = asObject(b);
      if (!bubble) continue;
      const role = bubbleRole(bubble);
      const content = bubbleText(bubble);
      if (!role || content.trim() === '') continue;
      messages.push({ role, content, at: null });
    }
    if (messages.length === 0) continue; // an empty tab is an abandoned tab, not a failure
    conversations.push({
      sourceId,
      title: (typeof tab.chatTitle === 'string' && tab.chatTitle.trim() !== '' ? tab.chatTitle : `Cursor chat`).slice(0, 200),
      startedAt: toIso(tab.lastSendTime),
      messages,
    });
  }
  return { conversations, unreadable };
}

/**
 * The one impure function: open the store read-only and hand rows to the
 * parsers. `node:sqlite` ships with Node ≥ 22.5 — no dependency, which
 * matters for a CLI people install to read their own machine.
 */
export async function readCursorDb(dbPath: string): Promise<CursorParse> {
  let DatabaseSync: new (path: string, opts: { readOnly: boolean }) => {
    prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
    close(): void;
  };
  try {
    // A dynamic specifier keeps tsc off the module's back: @types/node in this
    // repo predates node:sqlite, and the runtime (Node ≥ 22.5) is the real
    // authority on whether it exists — the catch below answers when it doesn't.
    const specifier = 'node:sqlite';
    ({ DatabaseSync } = (await import(specifier)) as unknown as { DatabaseSync: typeof DatabaseSync });
  } catch {
    throw new Error('reading the Cursor store needs Node 22.5 or newer (it ships the sqlite reader) — `node --version` says yours is older.');
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const conversations: CursorConversation[] = [];
    const unreadable: Unreadable[] = [];

    const bubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const getBubble = (composerId: string, bubbleId: string): unknown =>
      (asObject(bubbleStmt.get(`bubbleId:${composerId}:${bubbleId}`)) ?? {}).value ?? null;

    let composerRows: unknown[] = [];
    try {
      composerRows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
    } catch {
      // No cursorDiskKV table at all — a very old install. The legacy read
      // below still runs; this is a layout difference, not a failure.
    }
    for (const r of composerRows) {
      const row = asObject(r);
      const key = row && typeof row.key === 'string' ? row.key : '';
      const composerId = key.slice('composerData:'.length);
      if (!composerId) continue;
      const parsed = parseComposer(composerId, row?.value, getBubble);
      if (parsed.conversation) conversations.push(parsed.conversation);
      unreadable.push(...parsed.unreadable);
    }

    try {
      const legacyRow = asObject(db.prepare("SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'").get());
      if (legacyRow?.value !== undefined) {
        const legacy = parseLegacyChatData(legacyRow.value);
        conversations.push(...legacy.conversations);
        unreadable.push(...legacy.unreadable);
      }
    } catch {
      // No ItemTable — nothing legacy to read.
    }

    return { conversations, unreadable };
  } finally {
    db.close();
  }
}
