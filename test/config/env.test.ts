import { describe, it, expect } from 'vitest';
import { validateEnv, describeConfig, envReportLines, FEATURES } from '../../src/server/config/env.js';

/** A minimal env with just the boot-critical credentials set. */
const bootOnly = { DATABASE_URL: 'postgres://x', CREDENTIALS_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv;

describe('validateEnv — boots only with the critical credentials, degrades the rest', () => {
  it('is not ok when a boot-critical credential is missing', () => {
    expect(validateEnv({ CREDENTIALS_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv).ok).toBe(false); // no DATABASE_URL
    expect(validateEnv({ DATABASE_URL: 'x' } as NodeJS.ProcessEnv).ok).toBe(false); // no CREDENTIALS_KEY
    expect(validateEnv({} as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it('is ok once the boot-critical credentials are present, even with every feature off', () => {
    const report = validateEnv(bootOnly);
    expect(report.ok).toBe(true);
    // Every non-boot feature reports off, not a failure.
    expect(report.features.filter((f) => f.kind === 'feature').every((f) => f.status === 'off')).toBe(true);
  });

  it('reports a partially-configured feature as partial, not on', () => {
    const partial = { ...bootOnly, APNS_AUTH_KEY: 'a', APNS_KEY_ID: 'b' } as NodeJS.ProcessEnv; // 2 of 4
    const push = validateEnv(partial).features.find((f) => f.key === 'push')!;
    expect(push.status).toBe('partial');
    expect(push.missing).toEqual(['APNS_TEAM_ID', 'APNS_BUNDLE_ID']);
  });

  it('treats a blank string as unset', () => {
    expect(validateEnv({ DATABASE_URL: '  ', CREDENTIALS_KEY: 'k' } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  it('the build engine and evaluator are enumerated so the live layer has named seams', () => {
    const keys = FEATURES.map((f) => f.key);
    expect(keys).toContain('agent');
    expect(keys).toContain('evaluator');
  });
});

describe('describeConfig — booleans only, no secrets', () => {
  it('reports each feature on/off without any value', () => {
    const cfg = describeConfig({ ...bootOnly, DAYTONA_API_KEY: 'secret-value' } as NodeJS.ProcessEnv);
    expect(cfg.database).toBe(true);
    expect(cfg.agent).toBe(true);
    expect(cfg.push).toBe(false);
    // No secret leaks into the description.
    expect(JSON.stringify(cfg)).not.toContain('secret-value');
  });
});

describe('envReportLines — plain boot log, only the gaps', () => {
  it('lists only what is missing or partial', () => {
    const lines = envReportLines(validateEnv(bootOnly));
    expect(lines.join('\n')).toMatch(/Build engine/);
    expect(lines.join('\n')).not.toMatch(/Database/); // fully configured → not listed
  });
});
