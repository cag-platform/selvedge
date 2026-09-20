import net from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for the health monitor — the one place the server fetches a URL a
 * customer typed (`live_url` on a project). Without it, an owner could point
 * the probe at `http://169.254.169.254/…`, `http://127.0.0.1:6379/`, or an
 * internal `10.x` address and read status codes, body-keyword matches, and
 * connect/refused timing back out as an oracle.
 *
 * This is request-time only: it runs when a check runs, resolves DNS once per
 * probe, and holds no state — nothing periodic, nothing that ticks against a
 * metered service on its own.
 */

export class SsrfError extends Error {}

/** Private, loopback, link-local, CGNAT, and other non-public ranges. */
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // unparseable → refuse
  const [a, b] = p as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (test)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // not an IP → refuse
}

/**
 * Throw unless `rawUrl` is an http(s) URL whose host resolves ONLY to public
 * addresses. Returns the parsed URL so the caller doesn't parse twice.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('only http and https URLs are allowed');
  }
  const host = url.hostname;
  // An IP literal is checked directly; a name is resolved and every answer checked.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError('that address is not publicly routable');
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfError('could not resolve that host');
  }
  if (addresses.length === 0) throw new SsrfError('could not resolve that host');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new SsrfError('that host resolves to a private address');
  }
  return url;
}

/**
 * A fetch that re-validates the target at every redirect hop, so a public URL
 * that 302s to `http://169.254.169.254/` can't slip past the first check.
 * Manual redirects, capped. Same options surface as the callers need.
 */
export async function guardedFetch(rawUrl: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  let target = rawUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const url = await assertPublicUrl(target);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res; // a 3xx with no target — hand it back as-is
      target = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new SsrfError('too many redirects');
}
