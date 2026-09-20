import { describe, it, expect, afterEach } from 'vitest';
import { runCheck } from '../../src/server/monitor/probe.js';

describe('monitor/probe — the three probe kinds', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('http: up on res.ok, down with a plain detail on a bad status', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    expect((await runCheck({ kind: 'http', url: 'https://203.0.113.10' })).up).toBe(true);

    globalThis.fetch = (async () => new Response('err', { status: 503 })) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://203.0.113.10' });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/returned 503/);
  });

  it('http with expectedStatus: down when the status differs, even if 2xx', async () => {
    globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://203.0.113.10', expectedStatus: 201 });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/expected 201/);
  });

  it('keyword: up only when the text is present on the page', async () => {
    globalThis.fetch = (async () => new Response('<h1>Welcome to Loom</h1>', { status: 200 })) as typeof fetch;
    expect((await runCheck({ kind: 'keyword', url: 'https://203.0.113.10', keyword: 'Welcome' })).up).toBe(true);

    const r = await runCheck({ kind: 'keyword', url: 'https://203.0.113.10', keyword: 'Checkout' });
    expect(r.up).toBe(false);
    expect(r.detail).toMatch(/"Checkout" was not on the page/);
  });

  it('http: a network error is down, never a throw', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'https://203.0.113.10' });
    expect(r.up).toBe(false);
    expect(r.detail).toContain('ENOTFOUND');
  });

  it('measures latency from the injected clock', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    let t = 1000;
    const clock = () => (t += 250); // advances 250ms per read
    const r = await runCheck({ kind: 'http', url: 'https://203.0.113.10' }, clock);
    expect(r.latencyMs).toBeGreaterThan(0);
  });
});

describe('monitor/probe — SSRF guard', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('refuses a loopback target without ever fetching it', async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response('secret', { status: 200 }); }) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'http://127.0.0.1:6379/' });
    expect(fetched).toBe(false);
    expect(r.up).toBe(false);
    expect(r.detail).toBe('that address cannot be checked');
  });

  it('refuses the cloud metadata address', async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response('creds', { status: 200 }); }) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'http://169.254.169.254/latest/meta-data/' });
    expect(fetched).toBe(false);
    expect(r.detail).toBe('that address cannot be checked');
  });

  it('refuses a private RFC1918 target', async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return new Response('', { status: 200 }); }) as typeof fetch;
    const r = await runCheck({ kind: 'http', url: 'http://10.0.0.5:8080/' });
    expect(fetched).toBe(false);
    expect(r.up).toBe(false);
  });

  it('refuses a non-http scheme', async () => {
    const r = await runCheck({ kind: 'http', url: 'file:///etc/passwd' });
    expect(r.up).toBe(false);
    expect(r.detail).toBe('that address cannot be checked');
  });

  it('a private TCP target is not scanned', async () => {
    const r = await runCheck({ kind: 'tcp', url: 'http://192.168.1.1:22' });
    expect(r.up).toBe(false);
    expect(r.detail).toBe('that address cannot be checked');
  });
});
