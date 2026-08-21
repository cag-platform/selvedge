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

export type CompanionConfig = { api: string; token: string | null };

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
  };
}

export function saveConfig(config: CompanionConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
