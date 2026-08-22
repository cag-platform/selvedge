import { unzipSync } from 'fflate';
import { parseChatgptExport } from './chatgpt.js';
import { parseClaudeExport } from './claude.js';
import { parseGeminiExport } from './gemini.js';
import { VENDOR_NAMES, type ParseResult, type Vendor } from './types.js';

/**
 * The export ZIP → conversations.
 *
 * Only the one file that matters is decompressed. A full ChatGPT export is
 * mostly images and a DALL·E folder; a Takeout archive can be tens of
 * gigabytes of unrelated Google products. Reading the whole thing into memory
 * to find one JSON file would be the difference between an import that works
 * and one that takes the server down.
 */

const MAX_JSON_BYTES = 400 * 1024 * 1024;

/** Which file in the archive holds the conversations, per vendor. */
const WANTED: Array<{ vendor: Vendor; match: (path: string) => boolean }> = [
  // Claude and ChatGPT both call it conversations.json; they are told apart by
  // what is inside, below, not by the name.
  { vendor: 'chatgpt', match: (p) => /(^|\/)conversations\.json$/i.test(p) },
  { vendor: 'gemini', match: (p) => /(^|\/)MyActivity\.json$/i.test(p) && /gemini|bard/i.test(p) },
];

export type ReadResult =
  | ({ ok: true; vendor: Vendor; file: string } & ParseResult)
  | { ok: false; error: string };

/**
 * Claude vs ChatGPT: both ship `conversations.json`, and the only reliable
 * difference is the shape of a conversation. ChatGPT has `mapping`; Claude has
 * `chat_messages`. Guessing from the filename would file a whole history under
 * the wrong name.
 */
function vendorOfConversationsJson(json: unknown): Vendor | null {
  if (!Array.isArray(json)) return null;
  for (const item of json.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    if ('mapping' in item) return 'chatgpt';
    if ('chat_messages' in item) return 'claude';
  }
  return null;
}

/** ZIPs begin "PK". Cheaper than decoding 400MB to find out it wasn't JSON. */
function looksZipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** What a bare JSON file is, when it isn't in an archive at all. */
function vendorOfBareJson(json: unknown): Vendor | null {
  const conversation = vendorOfConversationsJson(json);
  if (conversation) return conversation;
  // Takeout's activity log: entries with a title, no conversation shape.
  if (Array.isArray(json) && json.some((item) => item && typeof item === 'object' && 'title' in (item as object))) return 'gemini';
  return null;
}

/**
 * The export, whether it arrived as an archive or as a single file.
 *
 * A bare .json is accepted because vendors hand one out — and because
 * refusing it taught people to zip it themselves, which is the one thing the
 * error message asks them not to do.
 */
export function readExport(bytes: Uint8Array): ReadResult {
  if (looksZipped(bytes)) return readExportZip(bytes);

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      ok: false,
      error: "That isn't a ZIP archive or a JSON file. Upload the export exactly as the vendor's download arrived.",
    };
  }

  const vendor = vendorOfBareJson(json);
  if (!vendor) {
    // The manifest case, and every other small JSON that isn't the export: say
    // what it looks like rather than repeating "I need a conversations.json".
    const shape = Array.isArray(json) ? `a list of ${json.length} ${json.length === 1 ? 'item' : 'items'}` : 'an object';
    return {
      ok: false,
      error: `That JSON is ${shape}, and no conversations are in it. If it's a manifest from the export email, the real download is what it points at — that's the file to upload.`,
    };
  }

  const parsed = vendor === 'chatgpt' ? parseChatgptExport(json) : vendor === 'claude' ? parseClaudeExport(json) : parseGeminiExport(json);
  return { ok: true, vendor, file: 'the file you uploaded', ...parsed };
}

export function readExportZip(zip: Uint8Array): ReadResult {
  let entries: Record<string, Uint8Array>;
  // Every entry's name passes through the filter, so the archive's contents
  // are known even though only the one file that matters is decompressed.
  const inside: string[] = [];
  try {
    entries = unzipSync(zip, {
      filter: (file) => {
        inside.push(file.name);
        return WANTED.some((w) => w.match(file.name)) && file.originalSize <= MAX_JSON_BYTES;
      },
    });
  } catch (err) {
    return { ok: false, error: `I couldn't open that as a ZIP file${err instanceof Error ? ` — ${err.message}` : ''}.` };
  }

  const names = Object.keys(entries);
  if (names.length === 0) {
    // SAY WHAT WAS IN IT. "I couldn't find conversations.json" without naming
    // what the archive DID hold leaves somebody staring at a file they have no
    // reason to doubt — which is exactly how an export manifest gets uploaded
    // three times.
    const listed = inside.slice(0, 8).map((n) => n.split('/').pop() || n);
    const more = inside.length - listed.length;
    const held = inside.length === 0
      ? 'That archive is empty.'
      : `It holds ${listed.map((n) => `"${n}"`).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
    return {
      ok: false,
      error: `I couldn't find a conversations.json (ChatGPT or Claude) or a Gemini MyActivity.json in that archive. ${held} Upload the export exactly as the download arrived — unzipping and re-zipping it moves things around, and a manifest from the export email is not the export itself.`,
    };
  }

  // Prefer the shallowest match: exports nest the real file at the top and
  // sometimes carry copies deeper in.
  const file = names.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0]!;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(entries[file]!));
  } catch (err) {
    return { ok: false, error: `${file} isn't readable JSON${err instanceof Error ? ` — ${err.message}` : ''}.` };
  }

  const named = WANTED.find((w) => w.match(file))!;
  const vendor = named.vendor === 'gemini' ? 'gemini' : vendorOfConversationsJson(json);
  if (!vendor) {
    return {
      ok: false,
      error: `I found ${file}, but it doesn't look like a ChatGPT or Claude export — neither conversation shape is in it.`,
    };
  }

  const parsed = vendor === 'chatgpt' ? parseChatgptExport(json) : vendor === 'claude' ? parseClaudeExport(json) : parseGeminiExport(json);
  return { ok: true, vendor, file, ...parsed };
}

/**
 * What the person is told afterwards. The count of what came in is never
 * given on its own: if anything was unreadable it is in the same sentence, at
 * the same volume, because "1,204 conversations imported" with 300 silently
 * dropped is the shape of lie this codebase refuses.
 */
export function importSummary(vendor: Vendor, filed: number, unreadable: number, filedUnder?: string): string {
  const name = VENDOR_NAMES[vendor];
  const main = `${filed} ${filed === 1 ? 'conversation' : 'conversations'} from ${name} ${filed === 1 ? 'is' : 'are'} in.`;
  // Where they went, when the owner didn't name a place — otherwise the chats
  // are simply gone as far as they can tell.
  const where = filedUnder ? ` They're under "${filedUnder}", and any conversation can pull one in by name.` : '';
  if (unreadable === 0) return `${main}${where} Nothing in the file was unreadable.`;
  return `${main}${where} ${unreadable} ${unreadable === 1 ? 'entry' : 'entries'} in the file I could not read — they are listed below, and they are not in.`;
}
