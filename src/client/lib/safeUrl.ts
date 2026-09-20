/**
 * A URL safe to put in an `href`. React does not sanitize href, so a stored
 * `javascript:` (or `data:`/`vbscript:`) value on an owner-settable link becomes
 * stored XSS the moment a teammate clicks it. The pack schema now refuses those
 * at write time; this is the render-time fence for values written before that,
 * or from any other source. Returns undefined for anything that isn't plain
 * http(s) or mailto, so the anchor simply has no destination.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return undefined;
}
