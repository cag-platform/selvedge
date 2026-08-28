import { describe, it, expect } from 'vitest';
import { validateEnv, describeConfig, envReportLines, FEATURES } from '../../src/server/config/env.js';

/** A minimal env with just the one boot-critical credential set. */
const bootOnly = { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv;

describe('validateEnv — boots with the database alone, degrades the rest', () => {
  it('is not ok only when the database is missing', () => {
    expect(validateEnv({} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(validateEnv({ CREDENTIALS_KEY: 'k'.repeat(40) } as NodeJS.ProcessEnv).ok).toBe(false); // still no DATABASE_URL
  });

  it('boots without the vault key — the vault degrades, it never crashes the app', () => {
    // The exact risk this guards: an existing deploy that predates the vault must
    // still boot. Only credential storage is off until CREDENTIALS_KEY is set.
    expect(validateEnv({ DATABASE_URL: 'x' } as NodeJS.ProcessEnv).ok).toBe(true);
  });

  it('is ok with just the database, every feature off', () => {
    const report = validateEnv(bootOnly);
    expect(report.ok).toBe(true);
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
    const cfg = describeConfig({
      ...bootOnly,
      OPENAI_API_KEY: 'secret-value',
      PREVIEW_RELAY_SIGNING_SECRET: 'relay-secret',
      PREVIEW_RELAY_PUBLIC_ORIGIN: 'https://tryselvedge.com',
    } as NodeJS.ProcessEnv);
    expect(cfg.database).toBe(true);
    expect(cfg.agent).toBe(true); // the sandbox host is present, which is all the engine needs
    expect(cfg.push).toBe(false);
    // No secret leaks into the description.
    expect(JSON.stringify(cfg)).not.toContain('secret-value');
  });

  /**
   * WHAT THE DEPLOYMENT OWES, AND WHAT IT DOESN'T.
   *
   * This used to require a Claude token too, which was the deployment claiming
   * a responsibility that wasn't its: whose account an agent runs on is a
   * per-org question, so a deployment-wide credential is neither required nor
   * sufficient and reporting the engine `off` without one told a deployment
   * full of BYO workspaces that it had no build engine.
   *
   * The engine is the machines. Nothing else.
   */
  it('is "on" with somewhere to run, and does not claim to need an account too', () => {
    const machinesOnly = describeConfig({ ...bootOnly, OPENAI_API_KEY: 'k', PREVIEW_RELAY_SIGNING_SECRET: 's', PREVIEW_RELAY_PUBLIC_ORIGIN: 'https://tryselvedge.com' } as NodeJS.ProcessEnv);
    expect(machinesOnly.agent).toBe(true);

    const nothing = describeConfig({ ...bootOnly } as NodeJS.ProcessEnv);
    expect(nothing.agent).toBe(false);
  });
});

describe('envReportLines — plain boot log, only the gaps', () => {
  it('lists only what is missing or partial', () => {
    const lines = envReportLines(validateEnv(bootOnly));
    expect(lines.join('\n')).toMatch(/Development Workspace Runtime/);
    // Fully configured → not listed. Anchored on the label's own line rather
    // than a bare substring, so an unrelated feature that happens to mention a
    // database doesn't make this pass or fail by accident.
    expect(lines.join('\n')).not.toMatch(/· Database:/);
  });
});
