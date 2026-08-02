import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

/**
 * Staged file uploads for the Workshop composer — the "attach a large file"
 * half of the attachment feature (screenshots stay small and travel inline
 * as base64; see build/agent.ts). A file the owner picks is streamed straight
 * to local disk by multer (bounded memory regardless of size), registered
 * here, and referenced by id in the next /message call; agent.ts streams it
 * from disk into the sandbox and deletes it — the bytes never sit whole in
 * a JS string or an HTTP request body.
 *
 * The registry is in-process memory, not the database: a staged upload is
 * only ever meant to live for the minute between picking a file and hitting
 * send. That means it doesn't survive a redeploy — an upload started right
 * as a deploy lands has to be re-attached, which is an honest, low-cost
 * tradeoff for not persisting large binaries anywhere.
 */

export type StagedUpload = {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  createdAt: number;
};

const registry = new Map<string, StagedUpload>();

export const UPLOAD_DIR = path.join(os.tmpdir(), 'selvedge-uploads');
/** An upload nobody sent within this long is abandoned — swept, not left to rot. */
const STAGED_TTL_MS = 30 * 60 * 1000;

/** Take ownership of a file multer already wrote to disk, and register it under a fresh id. */
export async function stageUpload(orgId: string, projectId: string, name: string, mime: string, tempPath: string, size: number): Promise<StagedUpload> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const id = ulid();
  const dest = path.join(UPLOAD_DIR, id);
  await fs.rename(tempPath, dest);
  const staged: StagedUpload = { id, orgId, projectId, name, mime, size, path: dest, createdAt: Date.now() };
  registry.set(id, staged);
  return staged;
}

/** Look up a staged upload, scoped to the org/project that staged it — never returns another tenant's file. */
export function getStagedUpload(orgId: string, projectId: string, id: string): StagedUpload | null {
  const u = registry.get(id);
  return u && u.orgId === orgId && u.projectId === projectId ? u : null;
}

/** Check a staged upload out of the registry (it's about to be used) — a second reference to the same id then misses. */
export function consumeStagedUpload(orgId: string, projectId: string, id: string): StagedUpload | null {
  const u = getStagedUpload(orgId, projectId, id);
  if (u) registry.delete(id);
  return u;
}

/** Delete an upload's bytes and drop it from the registry — used on validation failure so nothing orphaned is left on disk. */
export async function discardStagedUpload(id: string): Promise<void> {
  const u = registry.get(id);
  if (!u) return;
  registry.delete(id);
  await fs.unlink(u.path).catch(() => undefined);
}

/** Sweep uploads nobody sent — the disk-safety backstop for an abandoned attach. */
export async function sweepStagedUploads(now = Date.now()): Promise<void> {
  for (const [id, u] of registry) {
    if (now - u.createdAt > STAGED_TTL_MS) {
      registry.delete(id);
      await fs.unlink(u.path).catch(() => undefined);
    }
  }
}
