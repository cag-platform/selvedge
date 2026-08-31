import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { previewEnv } from '../db/schema/index.js';
import { encryptCredential, decryptCredential, vaultConfigured } from '../connectors/credentials/crypto.js';

/**
 * THE PREVIEW'S ENVIRONMENT — read, written, and never read back out.
 *
 * The crypto is the connector-credential vault, unchanged, with the project in
 * the AAD: a blob lifted from one project's row cannot be decrypted as
 * another's. That reuse is deliberate. A second encryption scheme is a second
 * thing to get wrong, and this holds exactly the same class of secret.
 */

/** The AAD component. Prefixed so it can never collide with a real provider id. */
function scope(projectId: string): string {
  return `preview-env:${projectId}`;
}

export type PreviewEnvSummary = {
  /** Names only. The values are not returned by anything, ever. */
  keys: string[];
  wantsDatabase: boolean;
  updatedAt: Date | null;
};

/**
 * Parse KEY=VALUE lines the way a `.env` file is written, forgivingly.
 *
 * Blank lines and `#` comments are skipped, `export ` prefixes are tolerated
 * because people paste from a shell, and matching quotes are stripped. A line
 * with no `=` is dropped rather than guessed at.
 *
 * Values are NOT trimmed beyond their surrounding whitespace: a trailing space
 * inside quotes is sometimes load-bearing in a token, and silently eating it
 * would produce a key that looks right and does not work.
 */
export function parseEnvText(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();

  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const at = body.indexOf('=');
    if (at <= 0) continue;

    const key = body.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(at + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // Last one wins, and the key keeps its original position — the same way a
    // shell would read the file.
    if (seen.has(key)) {
      out[out.findIndex((e) => e.key === key)] = { key, value };
      continue;
    }
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

/** Back to a file a shell can source. Quoted, so a value with spaces survives. */
export function toEnvFile(entries: Array<{ key: string; value: string }>): string {
  return entries.map((e) => `${e.key}='${e.value.replace(/'/g, `'\\''`)}'`).join('\n');
}

export async function getPreviewEnvSummary(db: Db, orgId: string, projectId: string): Promise<PreviewEnvSummary> {
  const [row] = await db
    .select()
    .from(previewEnv)
    .where(and(eq(previewEnv.orgId, orgId), eq(previewEnv.projectId, projectId)))
    .limit(1);
  return {
    keys: row?.keyNames ?? [],
    wantsDatabase: row?.wantsDatabase ?? false,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function setPreviewEnv(
  db: Db,
  orgId: string,
  projectId: string,
  text: string,
): Promise<PreviewEnvSummary> {
  if (!vaultConfigured()) {
    // Said rather than stored in the clear. A vault that isn't configured is a
    // deployment problem, and writing plaintext secrets "for now" is how they
    // stay in plaintext.
    throw new Error('This deployment has no credentials key set, so it cannot store preview secrets safely.');
  }
  const entries = parseEnvText(text);
  const keys = entries.map((e) => e.key);
  const valueEnc = entries.length ? encryptCredential(orgId, scope(projectId), toEnvFile(entries)) : null;

  await db
    .insert(previewEnv)
    .values({ orgId, projectId, valueEnc, keyNames: keys, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [previewEnv.orgId, previewEnv.projectId],
      set: { valueEnc, keyNames: keys, updatedAt: new Date() },
    });

  return getPreviewEnvSummary(db, orgId, projectId);
}

/**
 * Add or replace a small set of values without erasing credentials the owner
 * already supplied for another service. Values remain write-only at the HTTP
 * boundary; decryption happens here solely to produce the next encrypted blob.
 */
export async function mergePreviewEnv(
  db: Db,
  orgId: string,
  projectId: string,
  additions: Array<{ key: string; value: string }>,
): Promise<PreviewEnvSummary> {
  const current = parseEnvText((await previewEnvFile(db, orgId, projectId)) ?? '');
  const merged = new Map(current.map((entry) => [entry.key, entry.value]));
  for (const addition of additions) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(addition.key)) continue;
    merged.set(addition.key, addition.value);
  }
  return setPreviewEnv(db, orgId, projectId, toEnvFile([...merged].map(([key, value]) => ({ key, value }))));
}

export async function setPreviewDatabase(db: Db, orgId: string, projectId: string, wanted: boolean): Promise<void> {
  await db
    .insert(previewEnv)
    .values({ orgId, projectId, wantsDatabase: wanted, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [previewEnv.orgId, previewEnv.projectId],
      set: { wantsDatabase: wanted, updatedAt: new Date() },
    });
}

/**
 * The environment file to hand a sandbox, or null when there is nothing to
 * hand it.
 *
 * The only function that decrypts, and it is called at the moment the file is
 * uploaded — never earlier, never to show anybody. A blob that will not decrypt
 * comes back as null rather than throwing: a rotated key should mean "the
 * preview has no environment", which the owner can fix by pasting it again, not
 * "the preview is broken forever".
 */
export async function previewEnvFile(db: Db, orgId: string, projectId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(previewEnv)
    .where(and(eq(previewEnv.orgId, orgId), eq(previewEnv.projectId, projectId)))
    .limit(1);
  if (!row?.valueEnc) return null;
  try {
    return decryptCredential(orgId, scope(projectId), row.valueEnc);
  } catch {
    console.error(`preview env for ${orgId}/${projectId} could not be decrypted — treating it as unset`);
    return null;
  }
}
