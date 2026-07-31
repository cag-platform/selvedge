import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeVercelStatus, parseVercelTarget, getVercelDeployState } from '../../../src/server/connectors/vercel/client.js';

describe('vercel/normalizeVercelStatus — never guess "live"', () => {
  it('maps only READY to live', () => {
    expect(normalizeVercelStatus('READY')).toBe('live');
  });
  it('maps in-progress states to building', () => {
    for (const s of ['QUEUED', 'BUILDING', 'INITIALIZING']) expect(normalizeVercelStatus(s)).toBe('building');
  });
  it('maps error and canceled to failed', () => {
    expect(normalizeVercelStatus('ERROR')).toBe('failed');
    expect(normalizeVercelStatus('CANCELED')).toBe('failed');
  });
  it('maps anything unrecognised to unknown, never live', () => {
    for (const s of ['', 'PROMOTED', 'WHATEVER']) expect(normalizeVercelStatus(s)).toBe('unknown');
  });
});

describe('vercel/parseVercelTarget', () => {
  it('parses a bare project id and a team/project pair', () => {
    expect(parseVercelTarget('prj_1')).toEqual({ projectId: 'prj_1' });
    expect(parseVercelTarget('team_1/prj_1')).toEqual({ teamId: 'team_1', projectId: 'prj_1' });
  });
  it('returns null for anything else', () => {
    expect(parseVercelTarget('')).toBeNull();
    expect(parseVercelTarget('a/b/c')).toBeNull();
  });
});

describe('vercel/getVercelDeployState — graceful, never throws', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the normalized latest deploy state', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ deployments: [{ readyState: 'READY' }] }), { status: 200 })) as typeof fetch;
    expect(await getVercelDeployState('tok', { projectId: 'prj_1' })).toEqual({ status: 'live', rawState: 'READY' });
  });

  it('returns null when there is no deployment yet', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ deployments: [] }), { status: 200 })) as typeof fetch;
    expect(await getVercelDeployState('tok', { projectId: 'prj_1' })).toBeNull();
  });

  it('returns null on a transport failure rather than throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as typeof fetch;
    expect(await getVercelDeployState('tok', { projectId: 'prj_1' })).toBeNull();
  });
});
