import { describe, it, expect, afterEach } from 'vitest';
import { runCheck } from '../../src/server/monitor/probe.js';

describe('monitor/probe — the three probe kinds', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('http: up on res.ok, down with a plain detail on a bad status', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    expect((await runCheck({ kind: 'http', url: 'https://x' })).up).toBe(true);

    globalThis.fetch = (async () => new Response('err', { status: 503 })) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://x' });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/returned 503/);
  });

  it('http with expectedStatus: down when the status differs, even if 2xx', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://x', expectedStatus: 201 });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/expected 201/);
  });

  it('keyword: up only when the text is present on the page', async () => {
    globalThis.fetch = (async () => new Response('<h1>Welcome to Loom</h1>', { status: 200 })) as typeof fetch;
    expect((await runCheck({ kind: 'keyword', url: 'https://x', keyword: 'Welcome' })).up).toBe(true);

    const r = await runCheck({ kind: 'keyword', url: 'https://x', keyword: 'Checkout' });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/"Checkout" was not on the page/);
  });

  it('http: a network error is down, never a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://x' });
    expect(r.up).toBe(false);
    expect(r.detail).toContain('ENOTFOUND');
  });

  it('measures latency from the injected clock', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    let t = 1000;
    const clock = () => (t += 250); // advances 250ms per read
    const r = await runCheck({ kind: 'http', url: 'https://x' }, clock);
    expect(r.latencyMs).toBeGreaterThan(0);
  });
});
