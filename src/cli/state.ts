import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

/**
 * What the companion has already reported, so a restart doesn't re-narrate a
 * week of work and a still-running session isn't summarised half-finished.
 *
 * Keyed by file path, holding the size and modification time seen when it was
 * last sent. A session that grows afterwards (someone resumed it) is sent
 * again on purpose — the ingest is keyed on the session id, so a second send
 * updates the record rather than duplicating it.
 */

export const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

export type SeenFile = { size: number; mtimeMs: number; sessionId: string; sentAt: string };
export type WatchState = { files: Record<string, SeenFile> };

export function loadState(statePath = STATE_PATH): WatchState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as WatchState;
    return parsed && typeof parsed === 'object' && parsed.files ? parsed : { files: {} };
  } catch {
    return { files: {} };
  }
}

export function saveState(state: WatchState, statePath = STATE_PATH): void {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Has this file already been reported in exactly this shape? */
export function alreadySent(state: WatchState, file: string, size: number, mtimeMs: number): boolean {
  const seen = state.files[file];
  return Boolean(seen && seen.size === size && Math.abs(seen.mtimeMs - mtimeMs) < 1000);
}
