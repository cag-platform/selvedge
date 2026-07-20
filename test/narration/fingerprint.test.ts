import { describe, it, expect } from 'vitest';
import { normalizeErrorClass, fingerprintFor } from '../../src/server/narration/fingerprint.js';

describe('narration/fingerprint — normalizeErrorClass', () => {
  it('strips git shas and hashes', () => {
    expect(normalizeErrorClass('Deploy of a1b2c3d4e5f6 failed')).toBe('deploy of <hash> failed');
  });

  it('strips uuids', () => {
    expect(normalizeErrorClass('request 550e8400-e29b-41d4-a716-446655440000 timed out')).toBe(
      'request <uuid> timed out',
    );
  });

  it('strips filesystem paths', () => {
    expect(normalizeErrorClass('ENOENT: no such file /app/dist/server/index.js here')).toBe(
      'enoent: no such file <path> here',
    );
  });

  it('strips urls', () => {
    expect(normalizeErrorClass('fetch https://api.example.com/v1/thing?id=42 failed')).toBe('fetch <url> failed');
  });

  it('strips ISO timestamps before generic number stripping', () => {
    expect(normalizeErrorClass('lock held since 2026-07-19T10:03:22Z by worker 7')).toBe(
      'lock held since <ts> by worker <n>',
    );
  });

  it('strips bare numbers (ports, durations, line numbers)', () => {
    expect(normalizeErrorClass('timeout after 4500 ms on port 5432 at line 118')).toBe(
      'timeout after <n> ms on port <n> at line <n>',
    );
  });

  it('folds case and whitespace', () => {
    expect(normalizeErrorClass('  Build   FAILED  ')).toBe('build failed');
  });

  it('two instances of the same error class produce the same normalization', () => {
    const a = normalizeErrorClass('FK constraint failed on order 8812 (tx 0f3a9bc1122a) at 2026-07-19T02:11:00Z');
    const b = normalizeErrorClass('FK constraint failed on order 91 (tx ab12cd34ef56) at 2026-07-18T23:40:11Z');
    expect(a).toBe(b);
  });
});

describe('narration/fingerprint — fingerprintFor', () => {
  const base = {
    event_type: 'build.failed',
    error_signature: 'CI / e2e tests',
    tier: 'live_critical',
    detail_level: 'plain_expandable',
    language: 'en',
  };

  it('is stable for identical inputs', () => {
    expect(fingerprintFor(base)).toBe(fingerprintFor({ ...base }));
  });

  it('differs by event_type, tier, detail_level, and language', () => {
    expect(fingerprintFor({ ...base, event_type: 'build.succeeded' })).not.toBe(fingerprintFor(base));
    expect(fingerprintFor({ ...base, tier: 'personal' })).not.toBe(fingerprintFor(base));
    expect(fingerprintFor({ ...base, detail_level: 'plain_only' })).not.toBe(fingerprintFor(base));
    expect(fingerprintFor({ ...base, language: 'fi' })).not.toBe(fingerprintFor(base));
  });

  it('is invariant to instance-specific noise in the signature', () => {
    const a = fingerprintFor({ ...base, error_signature: 'Deploy run 4471 sha a1b2c3d failed' });
    const b = fingerprintFor({ ...base, error_signature: 'Deploy run 9932 sha 9f8e7d6 failed' });
    expect(a).toBe(b);
  });
});
