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

export function readExportZip(zip: Uint8Array): ReadResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter: (file) => WANTED.some((w) => w.match(file.name)) && file.originalSize <= MAX_JSON_BYTES });
  } catch (err) {
    return { ok: false, error: `I couldn't open that as a ZIP file${err instanceof Error ? ` — ${err.message}` : ''}.` };
  }

  const names = Object.keys(entries);
  if (names.length === 0) {
    return {
      ok: false,
      error:
        "I couldn't find a conversations.json (ChatGPT or Claude) or a Gemini MyActivity.json in that archive. Upload the export exactly as the download arrived — unzipping and re-zipping it moves things around.",
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
export function importSummary(vendor: Vendor, filed: number, unreadable: number): string {
  const name = VENDOR_NAMES[vendor];
  const main = `${filed} ${filed === 1 ? 'conversation' : 'conversations'} from ${name} ${filed === 1 ? 'is' : 'are'} in.`;
  if (unreadable === 0) return `${main} Nothing in the file was unreadable.`;
  return `${main} ${unreadable} ${unreadable === 1 ? 'entry' : 'entries'} in the file I could not read — they are listed below, and they are not in.`;
}
