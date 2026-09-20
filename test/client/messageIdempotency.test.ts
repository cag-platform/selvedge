import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { api } from '../../src/client/lib/api.js';

afterEach(() => vi.unstubAllGlobals());
it('reuses a message key after an ambiguous failure and creates a new key for a deliberate next message', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetcher = vi.fn()
    .mockRejectedValueOnce(new TypeError('connection lost'))
    .mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const path = '/api/threads/idempotency/message';
  const body = { text: 'Build this' };
  await expect(api.post(path, body)).rejects.toThrow('Connection lost');
  await api.post(path, body);
  // A Response is a consumable body; provide a fresh one for the next request.
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await api.post(path, body);
  const headers = fetcher.mock.calls.map(call => call[1].headers);
  expect(headers[0]['Idempotency-Key']).toBe(headers[1]['Idempotency-Key']);
  expect(headers[2]['Idempotency-Key']).not.toBe(headers[1]['Idempotency-Key']);
  expect(headers[0]['Content-Type']).toBe('application/json');
});
