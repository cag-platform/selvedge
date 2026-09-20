import net from 'node:net';
import { assertPublicUrl, guardedFetch, SsrfError } from './ssrfGuard.js';

/**
 * One health probe. Ported from toile's monitor/probe.ts — the network shape
 * is unchanged; only the input type is Selvedge's own minimal check shape so
 * this is testable without a DB row.
 *
 * Three kinds: HTTP (optionally requiring an exact status), TCP connect, and
 * keyword-in-body. 10s timeout. Any failure — bad status, missing keyword,
 * timeout, DNS error — is `up: false` with a plain detail line, never a throw.
 */

export type ProbeKind = 'http' | 'tcp' | 'keyword';

export type HealthCheckSpec = {
  kind: ProbeKind;
  url: string;
  expectedStatus?: number | null;
  keyword?: string | null;
};

export type ProbeResult = {
  up: boolean;
  latencyMs: number;
  detail: string | null;
};

const TIMEOUT_MS = 10_000;

/**
 * Exhaustive on purpose. This used to end in a bare `return probeHttp(...)`,
 * which meant an unrecognised kind silently ran as an HTTP GET — a new probe
 * kind would have failed *open into the wrong probe* rather than failing to
 * compile. The `never` guard makes adding a kind a compile error here, which is
 * the only place that can decide what a kind actually does.
 */
export async function runCheck(check: HealthCheckSpec, now: () => number = () => Date.now()): Promise<ProbeResult> {
  switch (check.kind) {
    case 'tcp':
      return probeTcp(check.url, now);
    case 'keyword':
      return probeHttp(check.url, null, check.keyword ?? null, now);
    case 'http':
      return probeHttp(check.url, check.expectedStatus ?? null, null, now);
    default: {
      const unreachable: never = check.kind;
      // Runtime belt as well as the compile-time brace: a row whose kind was
      // written by an older/newer deploy must not be probed as something else.
      return { up: false, latencyMs: 0, detail: `unknown check kind "${String(unreachable)}"` };
    }
  }
}

async function probeHttp(
  url: string,
  expectedStatus: number | null,
  keyword: string | null,
  now: () => number,
): Promise<ProbeResult> {
  const start = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Owner-supplied URL: resolve and reject private/loopback/link-local targets
    // before any connection, and re-check at every redirect hop.
    const res = await guardedFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Selvedge/1.0 HealthMonitor' },
    });
    const latencyMs = now() - start;

    if (keyword) {
      const body = await res.text();
      const found = body.includes(keyword);
      return { up: found, latencyMs, detail: found ? null : `expected text "${keyword}" was not on the page` };
    }

    const ok = expectedStatus ? res.status === expectedStatus : res.ok;
    return {
      up: ok,
      latencyMs,
      detail: ok ? null : `the page returned ${res.status}${expectedStatus ? ` (expected ${expectedStatus})` : ''}`,
    };
  } catch (err) {
    // A blocked-target refusal must not become a reconnaissance oracle: report
    // a fixed line, never which internal address was probed or why it failed.
    if (err instanceof SsrfError) return { up: false, latencyMs: now() - start, detail: 'that address cannot be checked' };
    return { up: false, latencyMs: now() - start, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeTcp(url: string, now: () => number): Promise<ProbeResult> {
  const start = now();
  let host: string;
  let port: number;
  try {
    const parsed = new URL(url.includes('://') ? url : `tcp://${url}`);
    host = parsed.hostname;
    port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return { up: false, latencyMs: 0, detail: `couldn't read a host and port from "${url}"` };
  }

  // Same SSRF fence as the HTTP path: refuse a private/loopback/link-local
  // target so this can't become an internal port scanner.
  try {
    await assertPublicUrl(`http://${host}:${port}`);
  } catch {
    return { up: false, latencyMs: now() - start, detail: 'that address cannot be checked' };
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: TIMEOUT_MS });
    socket.on('connect', () => {
      socket.end();
      resolve({ up: true, latencyMs: now() - start, detail: null });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ up: false, latencyMs: now() - start, detail: 'the connection timed out' });
    });
    socket.on('error', (err) => {
      resolve({ up: false, latencyMs: now() - start, detail: err.message });
    });
  });
}
