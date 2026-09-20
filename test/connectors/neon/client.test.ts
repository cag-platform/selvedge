import { afterEach, describe, expect, it } from 'vitest';
import { createNeonDatabase, neonProjectName } from '../../../src/server/connectors/neon/client.js';

describe('Neon production database provisioning', () => {
  const realFetch = globalThis.fetch;
  const priorKey = process.env.NEON_API_KEY;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (priorKey === undefined) delete process.env.NEON_API_KEY;
    else process.env.NEON_API_KEY = priorKey;
  });

  it('uses one deterministic project name', () => {
    expect(neonProjectName('org/unsafe', 'my project')).toBe('selvedge-org-unsafe-my-project');
  });

  it('reuses the exact existing project instead of issuing a second create request', async () => {
    process.env.NEON_API_KEY = 'key';
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      const url = String(input);
      if (url.includes('?search=')) {
        return new Response(JSON.stringify({ projects: [{ id: 'neon_1', name: 'selvedge-org-1-loom' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ uri: 'postgres://safe' }), { status: 200 });
    }) as typeof fetch;

    await expect(createNeonDatabase('org_1', 'loom')).resolves.toEqual({ neonProjectId: 'neon_1', connectionUri: 'postgres://safe' });
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('creates only after proving that no exact project exists', async () => {
    process.env.NEON_API_KEY = 'key';
    const methods: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (!init?.method) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      return new Response(JSON.stringify({ project: { id: 'neon_2' }, connection_uris: [{ connection_uri: 'postgres://new' }] }), { status: 201 });
    }) as typeof fetch;

    await expect(createNeonDatabase('org_1', 'loom')).resolves.toEqual({ neonProjectId: 'neon_2', connectionUri: 'postgres://new' });
    expect(methods).toEqual(['GET', 'POST']);
  });
});
