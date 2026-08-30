import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeDeployStatus, railwayGql, getDeployState, parseRailwayTarget } from '../../../src/server/connectors/railway/client.js';
import { configurePreviewService, createService } from '../../../src/server/connectors/railway/provision.js';

describe('railway/parseRailwayTarget — address a service, or skip it', () => {
  it('parses the three-part compound resource_id', () => {
    expect(parseRailwayTarget('proj_1/env_1/svc_1')).toEqual({ projectId: 'proj_1', environmentId: 'env_1', serviceId: 'svc_1' });
  });

  it('returns null for anything that is not exactly three non-empty parts', () => {
    for (const bad of ['proj/env', 'proj/env/svc/extra', 'proj//svc', '', 'justone', 'proj/env/']) {
      expect(parseRailwayTarget(bad)).toBeNull();
    }
  });
});

describe('railway/normalizeDeployStatus — never guess "live"', () => {
  it('maps only an explicit success to live', () => {
    expect(normalizeDeployStatus('SUCCESS')).toBe('live');
  });

  it('maps in-progress states to building', () => {
    for (const s of ['BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'NEEDS_APPROVAL']) {
      expect(normalizeDeployStatus(s)).toBe('building');
    }
  });

  it('maps failure states to failed', () => {
    for (const s of ['FAILED', 'CRASHED', 'REMOVED', 'REMOVING']) {
      expect(normalizeDeployStatus(s)).toBe('failed');
    }
  });

  it('maps anything unrecognised to unknown — a new Railway state is never silently "live"', () => {
    expect(normalizeDeployStatus('SOME_NEW_STATUS')).toBe('unknown');
    expect(normalizeDeployStatus('')).toBe('unknown');
    expect(normalizeDeployStatus('success')).toBe('unknown'); // case-sensitive on purpose
  });
});

describe('railway/railwayGql — carries the passed token, not a global', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('sends the customer token in the Authorization header', async () => {
    let seenAuth = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).Authorization ?? '';
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch;

    await railwayGql('cust-token-abc', 'query { ok }');
    expect(seenAuth).toBe('Bearer cust-token-abc');
  });

  it('surfaces GraphQL errors', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'unauthorized' }] }), { status: 200 })) as typeof fetch;
    await expect(railwayGql('t', 'query { x }')).rejects.toThrow(/unauthorized/);
  });

  it('surfaces a transport failure without leaking internals', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(railwayGql('t', 'query { x }')).rejects.toThrow(/Could not reach the Railway API/);
  });
});

describe('railway/getDeployState — normalized state, never throws', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const target = { projectId: 'p', environmentId: 'e', serviceId: 's' };

  it('returns the normalized status and deploy time', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { deployments: { edges: [{ node: { id: 'd1', status: 'SUCCESS', createdAt: '2026-07-31T00:00:00Z' } }] } },
        }),
        { status: 200 },
      )) as typeof fetch;

    const state = await getDeployState('tok', target);
    expect(state?.status).toBe('live');
    expect(state?.deployedAt).toBe('2026-07-31T00:00:00Z');
    expect(state?.rawStatus).toBe('SUCCESS');
  });

  it('returns null when there is no deployment yet', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { deployments: { edges: [] } } }), { status: 200 })) as typeof fetch;
    expect(await getDeployState('tok', target)).toBeNull();
  });

  it('returns null (never throws) on an API failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    expect(await getDeployState('tok', target)).toBeNull();
  });
});

describe('railway preview provisioning — pins the disposable ref and dev command', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('puts branch at ServiceCreateInput.branch, outside source', async () => {
    let variables: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      variables = JSON.parse(String(init.body)).variables;
      return new Response(JSON.stringify({ data: { serviceCreate: { id: 'svc_1' } } }), { status: 200 });
    }) as typeof fetch;

    await createService('token', 'project', 'preview', 'acme/app', { PORT: '3000' }, 'selvedge-preview/app-1');
    expect(variables).toEqual({
      input: {
        projectId: 'project',
        name: 'preview',
        branch: 'selvedge-preview/app-1',
        variables: { PORT: '3000' },
        source: { repo: 'acme/app' },
      },
    });
  });

  it('pins the service instance to the prepared development command', async () => {
    let variables: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      variables = JSON.parse(String(init.body)).variables;
      return new Response(JSON.stringify({ data: { serviceInstanceUpdate: true } }), { status: 200 });
    }) as typeof fetch;

    await configurePreviewService('token', { projectId: 'project', environmentId: 'env', serviceId: 'svc_1' });
    expect(variables).toEqual({ serviceId: 'svc_1', environmentId: 'env', input: { startCommand: 'npm run dev' } });
  });
});
