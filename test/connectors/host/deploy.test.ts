import { describe, it, expect } from 'vitest';
import { deployStateToEvent } from '../../../src/server/connectors/host/deploy.js';

const ctx = {
  orgId: 'org_a',
  source: 'railway' as const,
  repoFullName: 'acme/loom',
  serviceId: 'svc_1',
  occurredAt: '2026-07-31T12:00:00Z',
};

describe('deployStateToEvent — edge-triggered, false-calm-safe, host-generic', () => {
  it('emits nothing when the state has not changed', () => {
    expect(deployStateToEvent('live', 'live', ctx)).toBeNull();
    expect(deployStateToEvent('building', 'building', ctx)).toBeNull();
    expect(deployStateToEvent('failed', 'failed', ctx)).toBeNull();
  });

  it('building → live is a success, carrying the host as the source', () => {
    const e = deployStateToEvent('building', 'live', ctx);
    expect(e?.event_type).toBe('build.succeeded');
    expect(e?.source).toBe('railway');
    expect(e?.source_account_id).toBe('acme/loom');
  });

  it('carries the source through for a different host and namespaces the dedupe key', () => {
    const e = deployStateToEvent('building', 'live', { ...ctx, source: 'vercel' });
    expect(e?.source).toBe('vercel');
    expect(e?.dedupe_key.startsWith('vercel:')).toBe(true);
  });

  it('live → failed is a provisional deploy failure (resolution refines it)', () => {
    const e = deployStateToEvent('live', 'failed', ctx);
    expect(e?.event_type).toBe('deploy.failed_previous_serving');
    expect(e?.severity_hint).toBe('error');
  });

  it('anything → building is a build started', () => {
    expect(deployStateToEvent('live', 'building', ctx)?.event_type).toBe('build.started');
    expect(deployStateToEvent('failed', 'building', ctx)?.event_type).toBe('build.started');
  });

  it('FALSE-CALM: a transition INTO unknown emits nothing — losing sight is not a failure', () => {
    expect(deployStateToEvent('live', 'unknown', ctx)).toBeNull();
    expect(deployStateToEvent('building', 'unknown', ctx)).toBeNull();
    expect(deployStateToEvent('failed', 'unknown', ctx)).toBeNull();
  });

  it('first sight (prev null): reports the state found, but does not invent a recovery', () => {
    const live = deployStateToEvent(null, 'live', ctx);
    expect(live?.event_type).toBe('build.succeeded');
    expect(live?.event_type).not.toContain('recover');
    expect(deployStateToEvent(null, 'failed', ctx)?.event_type).toBe('deploy.failed_previous_serving');
  });

  it('coming out of unknown into live does not manufacture a phantom recovery', () => {
    const e = deployStateToEvent('unknown', 'live', ctx);
    expect(e?.event_type).toBe('build.succeeded');
    expect(e?.event_type).not.toContain('recover');
  });

  it('carries prev/current/host in raw for the technical register', () => {
    const e = deployStateToEvent('building', 'failed', ctx);
    expect(e?.raw).toMatchObject({ prev: 'building', current: 'failed', serviceId: 'svc_1', host: 'railway' });
  });
});
