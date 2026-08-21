import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the companion keeps its two facts: which Selvedge to talk to, and the
 * key it talks with. A file in the owner's home directory, mode 0600 — the same
 * place and the same expectations as any other CLI's credentials.
 *
 * Environment variables win over the file, so a CI run or a one-off never has
 * to write anything to disk.
 */

/**
 * `roots` overrides where each tool's logs are looked for. It exists because
 * two of the four readers are UNVERIFIED (cursor, gemini-cli): if their default
 * root is wrong, the watch finds nothing and that looks exactly like a quiet
 * week. An owner who can see `--dry-run` find nothing needs to be able to point
 * it at the right directory without waiting for a release.
 *
 * A root set to null turns that reader off entirely.
 */
export type RootOverrides = Partial<Record<'claude' | 'codex' | 'cursor' | 'gemini', string | null>>;

export type CompanionConfig = { api: string; token: string | null; roots?: RootOverrides };

export const CONFIG_DIR = path.join(homedir(), '.selvedge');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const DEFAULT_API = 'https://tryselvedge.com';

export function loadConfig(): CompanionConfig {
  let stored: Partial<CompanionConfig> = {};
  try {
    stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<CompanionConfig>;
  } catch {
    // No config yet, or an unreadable one. Either way the environment may still
    // carry everything needed, so this is not an error.
  }
  return {
    api: (process.env.SELVEDGE_API ?? stored.api ?? DEFAULT_API).replace(/\/+$/, ''),
    token: process.env.SELVEDGE_TOKEN ?? stored.token ?? null,
    ...(stored.roots && typeof stored.roots === 'object' ? { roots: stored.roots } : {}),
  };
}

/**
 * The defaults with the owner's overrides applied. A root explicitly set to
 * null is REMOVED rather than defaulted back — that is how a reader is turned
 * off, and silently re-enabling one would be the opposite of what was asked.
 */
export function rootsFrom(defaults: Record<string, string>, overrides: RootOverrides | undefined): Record<string, string | undefined> {
  const roots: Record<string, string | undefined> = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete roots[key];
    else if (typeof value === 'string' && value.trim() !== '') roots[key] = value.trim();
  }
  return roots;
}

export function saveConfig(config: CompanionConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
