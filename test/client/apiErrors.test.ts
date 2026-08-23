import { describe, it, expect, afterEach, vi } from 'vitest';
import { api, ApiError, sayFailure } from '../../src/client/lib/api.js';

/**
 * ZERO RAW ERRORS REACH A PERSON.
 *
 * Forty-odd places in this client do `e instanceof Error ? e.message : …` and
 * put the result on screen. That is the right pattern — the server's refusals
 * are written sentences, designed alongside the surface that shows them.
 *
 * What used to leak is everything that happened when there was NO sentence to
 * pass through: a `TypeError: Failed to fetch` when the network was down, a
 * "502 Bad Gateway" when the server answered without a body, a parse error
 * about an unexpected "<" when a proxy or the SPA catch-all replied with HTML.
 *
 * Fixing that at forty call sites would be forty chances to miss one, so it is
 * fixed at the one seam they all go through. These tests hold that seam: every
 * rejection out of `api` carries something a person can read.
 */

function respondWith(init: { status: number; body?: unknown; text?: string }) {
  vi.stubGlobal('fetch', async () => ({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: 'Bad Gateway',
    json: async () => {
      if (init.text !== undefined) throw new SyntaxError(`Unexpected token '<'`);
      return init.body ?? {};
    },
  }));
}

/** What must never be readable on screen, in any form. */
const TECHNICAL = [/TypeError/, /SyntaxError/, /Unexpected token/, /undefined/, /\bNaN\b/, /^\d{3}\b/, /Bad Gateway/];

function expectSpeakable(message: string) {
  expect(message.length).toBeGreaterThan(12);
  for (const pattern of TECHNICAL) expect(message).not.toMatch(pattern);
  // A sentence, not a fragment: it starts with a capital and ends like one.
  expect(message[0]).toBe(message[0]!.toUpperCase());
  expect(message.trimEnd().endsWith('.')).toBe(true);
}

describe('a failed call always carries a sentence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the server's own words through untouched", async () => {
    // The designed refusals — the ceiling, the stale decision, an unreachable
    // repo — are written with the surface that shows them. This seam must not
    // improve on them.
    respondWith({ status: 409, body: { error: "Selvedge isn't installed on cag-platform/balance." } });
    await expect(api.get('/api/x')).rejects.toThrow("Selvedge isn't installed on cag-platform/balance.");
  });

  it('never shows a status line when the server sent no words', async () => {
    respondWith({ status: 502, body: {} });
    const err = await api.get('/api/x').catch((e: unknown) => e as ApiError);
    expectSpeakable((err as ApiError).message);
    // The status is still THERE — surfaces branch on it — just not on screen.
    expect((err as ApiError).status).toBe(502);
  });

  it('says the network is down rather than reporting a TypeError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await api.get('/api/x').catch((e: unknown) => e as ApiError);
    expectSpeakable((err as ApiError).message);
    expect((err as ApiError).message).toMatch(/nothing was sent/);
    // status 0 is this module's own marker for "it never arrived anywhere".
    expect((err as ApiError).status).toBe(0);
  });

  it('survives an HTML error page where JSON was expected', async () => {
    // A proxy page, or the SPA catch-all answering an /api path that no longer
    // exists. There is no sentence in there, so it must not go looking.
    respondWith({ status: 500, text: '<!doctype html>' });
    expectSpeakable((await api.get('/api/x').catch((e: unknown) => e as ApiError) as ApiError).message);
  });

  it('survives HTML on a 200, which used to be a parse error on a working call', async () => {
    respondWith({ status: 200, text: '<!doctype html>' });
    expectSpeakable((await api.get('/api/x').catch((e: unknown) => e as ApiError) as ApiError).message);
  });

  it('treats a success with no body as a success', async () => {
    // `res.json()` rejects on an empty body, so a 204 used to surface as a
    // parse error on a call that had worked perfectly.
    respondWith({ status: 204, text: '' });
    await expect(api.del('/api/x')).resolves.toBeUndefined();
  });

  it('has a speakable sentence for every status it maps', () => {
    for (const status of [0, 401, 403, 404, 413, 429, 500, 502, 503, 418]) {
      expectSpeakable(sayFailure(status));
    }
  });
});
