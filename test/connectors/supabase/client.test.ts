import { describe, it, expect, afterEach } from 'vitest';
import {
  normalizeProjectStatus,
  listProjects,
  getProjectStatus,
} from '../../../src/server/connectors/supabase/client.js';

describe('supabase/normalizeProjectStatus — never guess "healthy"', () => {
  it('maps only ACTIVE_HEALTHY to healthy', () => {
    expect(normalizeProjectStatus('ACTIVE_HEALTHY')).toBe('healthy');
  });

  it('keeps unhealthy distinct — the DB is up but unwell', () => {
    expect(normalizeProjectStatus('ACTIVE_UNHEALTHY')).toBe('unhealthy');
  });

  it('keeps paused distinct — a documented migration trap, and recoverable', () => {
    for (const s of ['PAUSED', 'PAUSING', 'GOING_DOWN', 'INACTIVE']) {
      expect(normalizeProjectStatus(s)).toBe('paused');
    }
  });

  it('maps coming-up states to starting', () => {
    for (const s of ['COMING_UP', 'RESTORING', 'UPGRADING', 'RESTARTING', 'INIT_READY']) {
      expect(normalizeProjectStatus(s)).toBe('starting');
    }
  });

  it('maps hard failures to failed', () => {
    expect(normalizeProjectStatus('INIT_FAILED')).toBe('failed');
    expect(normalizeProjectStatus('REMOVED')).toBe('failed');
  });

  it('maps anything unrecognised to unknown — never silently healthy', () => {
    expect(normalizeProjectStatus('SOME_NEW_STATE')).toBe('unknown');
    expect(normalizeProjectStatus('')).toBe('unknown');
    expect(normalizeProjectStatus('active_healthy')).toBe('unknown'); // case-sensitive
  });
});

describe('supabase/listProjects & getProjectStatus', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('lists projects with normalized status and carries the token', async () => {
    let seenAuth = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).Authorization ?? '';
      return new Response(
        JSON.stringify([
          { id: 'ref1', name: 'app-db', status: 'ACTIVE_HEALTHY', region: 'us-east-1' },
          { id: 'ref2', name: 'idle-db', status: 'PAUSED' },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const projects = await listProjects('cust-token');
    expect(seenAuth).toBe('Bearer cust-token');
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({ ref: 'ref1', status: 'healthy', region: 'us-east-1' });
    expect(projects[1]).toMatchObject({ ref: 'ref2', status: 'paused', region: null });
  });

  it('returns [] (never throws) when the API fails', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    expect(await listProjects('t')).toEqual([]);
  });

  it('reads one project status, null on an unknown ref', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'ref1', name: 'db', status: 'ACTIVE_UNHEALTHY' }), { status: 200 })) as typeof fetch;
    const p = await getProjectStatus('t', 'ref1');
    expect(p?.status).toBe('unhealthy');
    expect(p?.rawStatus).toBe('ACTIVE_UNHEALTHY');

    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    expect(await getProjectStatus('t', 'missing')).toBeNull();
  });
});
