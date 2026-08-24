import { unzipSync } from 'fflate';

/**
 * READING A REPL OUT OF THE ZIP REPLIT GIVES YOU.
 *
 * "Import from Replit" is a MIGRATION, not a chat import: the thing being
 * carried is a working app — code, assets, config — on its way to a repo the
 * owner controls. Replit's own export is the zip download, so that is the
 * doorstep format; this module turns it into a clean file list a repo can be
 * built from, and nothing else.
 *
 * WHAT IS DROPPED IS NAMED. A Repl's zip carries the workspace, not the
 * project: node_modules, caches, virtualenvs — often 95% of the bytes and none
 * of the app. Those are filtered by a fixed list and REPORTED, so "your Repl
 * is in" never quietly means "except the parts I decided about". Build outputs
 * like dist/ are kept: for a static site they ARE the app, and a builder can
 * always regenerate what it doesn't need.
 *
 * THE CAPS REFUSE, THEY NEVER TRIM. An import that lands 380 of 400 files is
 * an app that almost works and a bug hunt nobody signed up for. Over a cap,
 * the answer is the honest refusal naming what was too big — the owner can
 * remove the offending directory and try again, knowing exactly why.
 */

export type AppFile = { path: string; bytes: Uint8Array };

export type AppZipResult =
  | { ok: true; files: AppFile[]; skipped: string[]; skippedCount: number }
  | { ok: false; error: string };

/** Workspace residue, not app. Matched as whole path segments. */
const JUNK_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.cache',
  '.upm',
  '.pythonlibs',
  '__pycache__',
  '.venv',
  'venv',
  '.local',
  '.config',
  '.npm',
  '.next',
  '.replit_cache',
]);

/** After filtering. More files than this is a workspace, not an app. */
export const MAX_FILES = 400;
/** Unpacked, after filtering. */
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
/** One file over this is an asset that belongs in object storage, not git. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

function isJunk(path: string): boolean {
  return path.split('/').some((seg) => JUNK_SEGMENTS.has(seg));
}

export function readAppZip(bytes: Uint8Array): AppZipResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { ok: false, error: "that file isn't a zip I can open — download the Repl as a zip and upload that." };
  }

  // Normalize: forward slashes, no directory rows, no path games. A zip entry
  // trying to climb out of its own tree is refused whole — these bytes go into
  // a git tree under the owner's name, and a crafted path must not decide
  // where.
  const raw: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [name, data] of Object.entries(entries)) {
    const path = name.replace(/\\/g, '/');
    if (path.endsWith('/')) continue; // a directory row, not a file
    if (path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '')) {
      return { ok: false, error: 'that zip contains paths I refuse to write (absolute or escaping) — it does not look like a Repl export.' };
    }
    raw.push({ path, bytes: data });
  }
  if (raw.length === 0) return { ok: false, error: 'that zip is empty.' };

  // Replit wraps the export in one folder named after the Repl — unwrap it so
  // the repo root is the app root, which is where every builder will look.
  const firstSeg = (p: string) => p.slice(0, p.indexOf('/') === -1 ? p.length : p.indexOf('/'));
  const tops = new Set(raw.map((f) => firstSeg(f.path)));
  const unwrap = tops.size === 1 && raw.every((f) => f.path.includes('/'));
  const files0 = unwrap ? raw.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf('/') + 1) })) : raw;

  const skippedDirs = new Set<string>();
  let skippedCount = 0;
  const files: AppFile[] = [];
  for (const f of files0) {
    if (isJunk(f.path)) {
      skippedCount += 1;
      skippedDirs.add(f.path.split('/').find((seg) => JUNK_SEGMENTS.has(seg))!);
      continue;
    }
    files.push(f);
  }
  if (files.length === 0) {
    return { ok: false, error: 'after leaving out the workspace junk (node_modules and friends), nothing was left — that zip holds no app.' };
  }

  const over = files.filter((f) => f.bytes.length > MAX_FILE_BYTES);
  if (over.length > 0) {
    const worst = over.sort((a, b) => b.bytes.length - a.bytes.length)[0]!;
    return {
      ok: false,
      error: `${worst.path} is ${(worst.bytes.length / 1024 / 1024).toFixed(1)}MB — too big for a repo file. Remove it from the zip (${over.length} file${over.length === 1 ? ' is' : 's are'} over ${MAX_FILE_BYTES / 1024 / 1024}MB) and try again.`,
    };
  }
  if (files.length > MAX_FILES) {
    return {
      ok: false,
      error: `${files.length} files after filtering — more than the ${MAX_FILES} an app import takes. That usually means a dependency or build directory I don't know by name; remove it from the zip and try again.`,
    };
  }
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `${(total / 1024 / 1024).toFixed(0)}MB of files after filtering — more than the ${MAX_TOTAL_BYTES / 1024 / 1024}MB an app import takes. Large assets belong in storage, not git; remove them and try again.`,
    };
  }

  return { ok: true, files, skipped: [...skippedDirs].sort(), skippedCount };
}
