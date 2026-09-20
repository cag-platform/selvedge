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
 * like dist/ are kept: for a static site they ARE the app. Generated source
 * maps are the exception: they are rebuildable diagnostics, not runtime files,
 * and Replit exports can contain several multi-megabyte copies of them.
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
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** One file over this is an asset that belongs in object storage, not git. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

function isJunk(path: string): boolean {
  return path.split('/').some((seg) => JUNK_SEGMENTS.has(seg));
}

/** Finder metadata added when a downloaded Replit folder is zipped on macOS. */
function isMacArchiveMetadata(path: string): boolean {
  const segments = path.split('/');
  const basename = segments.at(-1) ?? '';
  return segments.includes('__MACOSX') || basename === '.DS_Store' || basename.startsWith('._');
}

/** Rebuildable diagnostics emitted by JS/CSS bundlers, never app runtime. */
function isGeneratedSourceMap(path: string): boolean {
  return /\.(?:js|mjs|cjs|css)\.map$/i.test(path);
}

export function readAppZip(bytes: Uint8Array): AppZipResult {
  let entries: Record<string, Uint8Array>;
  // DECOMPRESS DEFENSIVELY. unzipSync with no filter inflates every entry into
  // memory before any cap runs, so a 200 MB archive of zeros can expand to tens
  // of GB and OOM the process before the size checks below are ever reached.
  // The filter runs against each entry's DECLARED size first: junk (node_modules
  // and friends) and macOS metadata are never inflated at all, and an entry or
  // archive that declares more than the caps is refused before decompression.
  // A dishonestly-declared bomb still can't get far — the running total is
  // enforced here, the upload itself is capped upstream, and the route is rate
  // limited. This mirrors consumer/read.ts, which already reads exports this way.
  // The filter decides, from each entry's DECLARED size and name, what to even
  // decompress. Junk (node_modules and friends), macOS metadata, and generated
  // source maps are categorized and dropped here so they are never inflated,
  // and the running declared total of the files we DO keep is capped — so an
  // archive that declares tens of GB of real files is refused before its bytes
  // are ever expanded into memory, rather than after (which OOMs first).
  const skippedDirs = new Set<string>();
  let skippedCount = 0;
  let macCount = 0;
  let junkCount = 0;
  let declaredKeptTotal = 0;
  let bombError: string | null = null;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        const path = file.name.replace(/\\/g, '/');
        if (path.endsWith('/')) return false; // directory row, uncounted
        if (isMacArchiveMetadata(path)) { skippedCount += 1; macCount += 1; skippedDirs.add('macOS folder metadata'); return false; }
        if (isJunk(path)) { skippedCount += 1; junkCount += 1; skippedDirs.add(path.split('/').find((seg) => JUNK_SEGMENTS.has(seg))!); return false; }
        if (isGeneratedSourceMap(path)) { skippedCount += 1; junkCount += 1; skippedDirs.add('generated source maps'); return false; }
        declaredKeptTotal += file.originalSize;
        if (declaredKeptTotal > MAX_TOTAL_BYTES) {
          bombError = `that export declares more than ${MAX_TOTAL_BYTES / 1024 / 1024}MB of app files — large assets belong in storage, not git. Remove them from the export and try again.`;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { ok: false, error: "that file isn't a zip I can open — download the Repl as a zip and upload that." };
  }
  if (bombError) return { ok: false, error: bombError };

  // Kept (real) files only — junk/metadata were dropped above. A real entry
  // trying to climb out of its own tree is still refused whole: these bytes go
  // into a git tree under the owner's name, and a crafted path must not decide
  // where.
  const appRaw: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const [name, data] of Object.entries(entries)) {
    const path = name.replace(/\\/g, '/');
    if (path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '')) {
      return { ok: false, error: 'that zip contains paths I refuse to write (absolute or escaping) — it does not look like a Repl export.' };
    }
    appRaw.push({ path, bytes: data });
  }
  if (appRaw.length === 0) {
    if (macCount === 0 && junkCount === 0) return { ok: false, error: 'that zip is empty.' };
    if (junkCount === 0) return { ok: false, error: 'that zip contains only macOS folder metadata and no app.' };
    return { ok: false, error: 'after leaving out the workspace junk (node_modules and friends), nothing was left — that zip holds no app.' };
  }

  // Replit wraps the export in one folder named after the Repl — unwrap it so
  // the repo root is the app root, which is where every builder will look.
  const firstSeg = (p: string) => p.slice(0, p.indexOf('/') === -1 ? p.length : p.indexOf('/'));
  const tops = new Set(appRaw.map((f) => firstSeg(f.path)));
  const unwrap = tops.size === 1 && appRaw.every((f) => f.path.includes('/'));
  const files: AppFile[] = unwrap ? appRaw.map((f) => ({ ...f, path: f.path.slice(f.path.indexOf('/') + 1) })) : appRaw;

  const over = files.filter((f) => f.bytes.length > MAX_FILE_BYTES);
  if (over.length > 0) {
    const worst = over.sort((a, b) => b.bytes.length - a.bytes.length)[0]!;
    return {
      ok: false,
      error: `${worst.path} is ${(worst.bytes.length / 1024 / 1024).toFixed(1)}MB — too large to move safely into the project's GitHub repository (${over.length} file${over.length === 1 ? ' is' : 's are'} over ${MAX_FILE_BYTES / 1024 / 1024}MB). Move that asset to storage or remove it from the export, then try again.`,
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
