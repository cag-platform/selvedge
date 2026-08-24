import { tidy, type ImportedConversation, type Vendor } from './consumer/types.js';

/**
 * WHAT THE COMPANION MAY HAND OVER — the checked shape of a machine-to-machine
 * import.
 *
 * The zip route exists for histories a vendor exports; this exists for
 * histories no vendor exports at all. Cursor's chats live in a local SQLite
 * file on the owner's machine — there is no download button — so the companion
 * CLI reads them where they are and sends them here, already normalized.
 *
 * TRUSTED CALLER, UNTRUSTED CONTENT. The bearer token says which org this is;
 * it says nothing about the bytes, which came out of a third-party app's
 * database via a parser chasing an undocumented format. So every field is
 * checked, every bound is enforced, and what fails a check is COUNTED AND
 * NAMED rather than silently dropped — the import-pipe discipline, applied to
 * our own CLI exactly as it is to a vendor's zip.
 *
 * THE BOUNDS ARE PER CALL, NOT PER HISTORY. The CLI chunks; a history of five
 * thousand conversations is twenty-five calls, not one giant body a proxy
 * somewhere refuses.
 */

/** Conversations one call may carry — the CLI sends more calls, not more rows. */
export const MAX_CONVERSATIONS_PER_CALL = 200;
/** Messages one conversation may carry before we stop believing it is one conversation. */
export const MAX_MESSAGES_PER_CONVERSATION = 4_000;
/** Longer than this, a "message" is a file that fell into the chat column. */
export const MAX_MESSAGE_CHARS = 200_000;

/** Vendors whose histories genuinely have no export path — the only ones this door takes. */
const CLI_VENDORS = new Set<Vendor>(['cursor']);

export type IngestBatch = {
  vendor: Vendor;
  conversations: ImportedConversation[];
  /** What the CLI's own parser could not read, counted so the summary is honest. */
  unreadable: Array<{ ref: string; reason: string }>;
};

export type IngestCheck = { ok: true; value: IngestBatch } | { ok: false; error: string };

function isIsoish(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
}

export function checkConversationBatch(body: unknown): IngestCheck {
  const b = (body ?? {}) as Record<string, unknown>;

  const vendor = b.vendor;
  if (typeof vendor !== 'string' || !CLI_VENDORS.has(vendor as Vendor)) {
    return { ok: false, error: 'this door takes histories that have no export file — for a ChatGPT or Claude zip, use the import on the web.' };
  }

  if (!Array.isArray(b.conversations)) return { ok: false, error: 'no conversations came with that.' };
  if (b.conversations.length > MAX_CONVERSATIONS_PER_CALL) {
    return { ok: false, error: `at most ${MAX_CONVERSATIONS_PER_CALL} conversations per call — send the rest in further calls.` };
  }

  const unreadable: Array<{ ref: string; reason: string }> = [];
  // The CLI reports what its parser already failed on; those counts ride
  // through so the final summary covers the whole history, not just the half
  // that made it into JSON.
  if (Array.isArray(b.unreadable)) {
    for (const u of b.unreadable.slice(0, 500)) {
      const item = (u ?? {}) as Record<string, unknown>;
      unreadable.push({
        ref: typeof item.ref === 'string' ? item.ref.slice(0, 200) : 'unknown',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : 'unreadable',
      });
    }
  }

  const conversations: ImportedConversation[] = [];
  for (const [i, raw] of (b.conversations as unknown[]).entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const ref = typeof c.sourceId === 'string' && c.sourceId !== '' ? c.sourceId : `#${i}`;

    if (typeof c.sourceId !== 'string' || c.sourceId.trim() === '' || c.sourceId.length > 200) {
      unreadable.push({ ref, reason: 'no usable id — a re-import could not tell it from a duplicate' });
      continue;
    }
    if (!Array.isArray(c.messages) || c.messages.length === 0) {
      unreadable.push({ ref, reason: 'no messages' });
      continue;
    }
    if (c.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      unreadable.push({ ref, reason: `${c.messages.length} messages in one conversation — more than I believe` });
      continue;
    }

    const messages: ImportedConversation['messages'] = [];
    let droppedHere = 0;
    for (const m of c.messages as unknown[]) {
      const msg = (m ?? {}) as Record<string, unknown>;
      const role = msg.role === 'owner' || msg.role === 'agent' ? msg.role : null;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (!role || content.trim() === '') {
        droppedHere += 1;
        continue;
      }
      if (content.length > MAX_MESSAGE_CHARS) {
        // Not truncated: a message silently cut in half reads as complete,
        // which is worse than being reported missing.
        droppedHere += 1;
        continue;
      }
      messages.push({ role, content: tidy(content), at: isIsoish(msg.at) ? msg.at : null });
    }

    if (messages.length === 0) {
      unreadable.push({ ref, reason: 'every message in it was empty or unreadable' });
      continue;
    }
    if (droppedHere > 0) {
      unreadable.push({ ref, reason: `${droppedHere} message${droppedHere === 1 ? '' : 's'} in this conversation could not be read` });
    }

    conversations.push({
      sourceId: c.sourceId.trim(),
      title: (typeof c.title === 'string' && c.title.trim() !== '' ? c.title : ref).slice(0, 200),
      startedAt: isIsoish(c.startedAt) ? c.startedAt : null,
      messages,
    });
  }

  return { ok: true, value: { vendor: vendor as Vendor, conversations, unreadable } };
}
