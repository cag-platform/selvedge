import type { AttachedImage } from '../build/agent.js';

/**
 * WHAT MAY RIDE WITH A MESSAGE — one set of rules, wherever the message lands.
 *
 * These validators lived inside the workshop router, which was the only door
 * that took attachments — and the Inbox message route, the one both clients
 * actually compose into, quietly dropped `images` and `files` on the floor:
 * the web composer offered the buttons, the server read neither key, and a
 * screenshot attached to a conversation simply never arrived. One module now,
 * used by both routes, so an attachment means the same thing at every door.
 *
 * THE CAPS, AND WHY THESE NUMBERS. Images travel inline as base64 inside the
 * message JSON: ten at 6MB each is ~80MB encoded, inside the 100MB body limit
 * the message routes carry. Staged files never enter a JSON body at all —
 * multer streams them to disk and the message references them by id — so
 * their cap is about sandbox hygiene, not transport: ten files at up to 300MB
 * each per message. A cap that is hit refuses with the number in the
 * sentence; nothing is trimmed to fit.
 */

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_FILES = 10;
/** Generous — disk-streamed, not memory-buffered, so size isn't the risk a JSON body would make it. */
export const MAX_STAGED_FILE_BYTES = 300 * 1024 * 1024;

function base64ByteLength(s: string): number {
  return Math.floor((s.length * 3) / 4);
}

/** Validate the message body's inline images; returns a plain-English error, or the images. */
export function validateImages(images: unknown): { error: string } | { images: AttachedImage[] } {
  const out: AttachedImage[] = [];
  if (images !== undefined) {
    if (!Array.isArray(images)) return { error: 'images must be a list' };
    if (images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images per message` };
    for (const img of images) {
      const mime = (img as { mime?: unknown })?.mime;
      const dataBase64 = (img as { dataBase64?: unknown })?.dataBase64;
      if (typeof mime !== 'string' || !IMAGE_MIMES.has(mime)) return { error: 'images must be PNG, JPEG, WebP, or GIF' };
      if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return { error: 'an image is missing its data' };
      if (base64ByteLength(dataBase64) > MAX_IMAGE_BYTES) return { error: `an image is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB` };
      out.push({ mime, dataBase64 });
    }
  }
  return { images: out };
}

/** Validate staged-file references; the ids are resolved (and consumed) by the route. */
export function validateFileRefs(files: unknown): { error: string } | { ids: string[] } {
  if (files === undefined) return { ids: [] };
  if (!Array.isArray(files)) return { error: 'files must be a list' };
  if (files.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per message` };
  const ids: string[] = [];
  for (const f of files) {
    const id = (f as { id?: unknown })?.id;
    if (typeof id !== 'string' || id.trim() === '') return { error: 'a file is missing its upload id — try attaching it again' };
    ids.push(id);
  }
  return { ids };
}
