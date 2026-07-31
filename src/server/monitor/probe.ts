import net from 'node:net';

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

export async function runCheck(check: HealthCheckSpec, now: () => number = () => Date.now()): Promise<ProbeResult> {
  if (check.kind === 'tcp') return probeTcp(check.url, now);
  if (check.kind === 'keyword') return probeHttp(check.url, null, check.keyword ?? null, now);
  return probeHttp(check.url, check.expectedStatus ?? null, null, now);
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
    const res = await fetch(url, {
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
    return { up: false, latencyMs: now() - start, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function probeTcp(url: string, now: () => number): Promise<ProbeResult> {
  const start = now();
  return new Promise((resolve) => {
    let host: string;
    let port: number;
    try {
      const parsed = new URL(url.includes('://') ? url : `tcp://${url}`);
      host = parsed.hostname;
      port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    } catch {
      resolve({ up: false, latencyMs: 0, detail: `couldn't read a host and port from "${url}"` });
      return;
    }

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
