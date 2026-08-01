/**
 * The preview allowlist — the SSRF guard for the preview proxy, ported from
 * Toile. The server refuses to STORE a preview URL that doesn't match, and the
 * proxy only ever forwards to a stored, matching URL — so the proxy can never
 * be steered at an arbitrary host.
 *
 * Daytona preview hostnames are `{port}-{sandboxId}.<proxy domain>`. Two proxy
 * domain families exist: `proxy.daytona.work` (documented) and
 * `daytonaproxyNN.net` (what getPreviewLink() actually returns for this
 * deployment). Anything else is refused.
 */
const ALLOWED_PREVIEW_HOSTS = [
  /^\d{1,5}-[a-z0-9][a-z0-9-]*\.proxy\.daytona\.work$/,
  /^\d{1,5}-[a-z0-9][a-z0-9-]*\.daytonaproxy\d+\.net$/,
];

export function isAllowedPreviewUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    ALLOWED_PREVIEW_HOSTS.some((pattern) => pattern.test(url.hostname))
  );
}
