import { describe, it, expect } from 'vitest';
import { generateChecks, runCheckSpec, runGeneratedChecks, templateRunChecks, type CheckSpec, type RunCheckDeps } from '../../src/server/verify/checks.js';
import { computeVerdict } from '../../src/server/verify/verdict.js';

describe('generateChecks — only checks it can honestly stand behind', () => {
  it('produces a smoke check from the live URL', () => {
    const specs = generateChecks({ liveUrl: 'https://loom.example' });
    expect(specs.map((s) => s.kind)).toEqual(['smoke']);
    expect(specs[0]!.how).toMatchObject({ via: 'http', url: 'https://loom.example' });
  });

  it('adds a regression keyword check when the pack knows a phrase that should render', () => {
    const specs = generateChecks({ liveUrl: 'https://loom.example', regressionKeyword: 'Checkout' });
    expect(specs.map((s) => s.kind)).toEqual(['smoke', 'regression']);
    expect(specs[1]!.how).toMatchObject({ via: 'http', keyword: 'Checkout' });
  });

  it('emits acceptance as manual — the template cannot judge intent itself', () => {
    const specs = generateChecks({ liveUrl: 'https://loom.example', requestText: 'make the gift note optional' });
    const acceptance = specs.find((s) => s.kind === 'acceptance')!;
    expect(acceptance.how.via).toBe('manual');
  });

  it('produces no smoke check when it does not know where the app lives', () => {
    // No live URL → no smoke → the verdict will (correctly) be inconclusive.
    expect(generateChecks({ requestText: 'do a thing' }).some((s) => s.kind === 'smoke')).toBe(false);
  });
});

describe('runCheckSpec — manual and un-runnable checks are could_not_run, never a pass', () => {
  it('a manual check is always could_not_run', async () => {
    const spec: CheckSpec = { kind: 'acceptance', name: 'x', how: { via: 'manual', note: 'confirm it' } };
    expect((await runCheckSpec(spec)).outcome).toBe('could_not_run');
  });

  it('a command check with no sandbox is could_not_run', async () => {
    const spec: CheckSpec = { kind: 'regression', name: 'tests pass', how: { via: 'command', command: 'npm test' } };
    expect((await runCheckSpec(spec)).outcome).toBe('could_not_run');
  });

  it('an http check maps a probe pass/fail through', async () => {
    const http: RunCheckDeps['http'] = async ({ url }) => ({ ok: url.includes('good'), detail: url.includes('good') ? null : 'HTTP 500' });
    const good: CheckSpec = { kind: 'smoke', name: 's', how: { via: 'http', url: 'https://good' } };
    const bad: CheckSpec = { kind: 'smoke', name: 's', how: { via: 'http', url: 'https://bad' } };
    expect((await runCheckSpec(good, { http })).outcome).toBe('pass');
    expect((await runCheckSpec(bad, { http })).outcome).toBe('fail');
  });

  it('an http probe that throws is could_not_run, not a fail', async () => {
    const http: RunCheckDeps['http'] = async () => { throw new Error('boom'); };
    const spec: CheckSpec = { kind: 'smoke', name: 's', how: { via: 'http', url: 'https://x' } };
    expect((await runCheckSpec(spec, { http })).outcome).toBe('could_not_run');
  });

  it('a command check runs in the sandbox when one is provided', async () => {
    const exec: RunCheckDeps['exec'] = async (cmd) => ({ ok: cmd === 'npm test', detail: null });
    const spec: CheckSpec = { kind: 'regression', name: 'tests', how: { via: 'command', command: 'npm test' } };
    expect((await runCheckSpec(spec, { exec })).outcome).toBe('pass');
  });
});

describe('templateRunChecks → verdict — the honest degradation, end to end', () => {
  const http: RunCheckDeps['http'] = async () => ({ ok: true, detail: null }); // app is up

  it('a live app with only template checks lands at probably (acceptance unconfirmed)', async () => {
    // smoke passes, regression passes, acceptance is manual → could_not_run → probably.
    const results = await templateRunChecks(
      { liveUrl: 'https://loom.example', regressionKeyword: 'Checkout', requestText: 'make the gift note optional' },
      { http },
    );
    expect(computeVerdict(results)).toBe('probably');
  });

  it('no live URL means no smoke proof → inconclusive', async () => {
    const results = await templateRunChecks({ requestText: 'do a thing' }, { http });
    expect(computeVerdict(results)).toBe('inconclusive');
  });

  it('a down app fails smoke → didnt_work', async () => {
    const down: RunCheckDeps['http'] = async () => ({ ok: false, detail: 'HTTP 500' });
    const results = await templateRunChecks({ liveUrl: 'https://loom.example' }, { http: down });
    expect(computeVerdict(results)).toBe('didnt_work');
  });

  it('with the model confirming acceptance (a passing acceptance result), it reaches verified', async () => {
    // Simulate the model path: the same specs, but acceptance is a runnable command that passes.
    const specs: CheckSpec[] = [
      { kind: 'smoke', name: 's', how: { via: 'http', url: 'https://loom.example' } },
      { kind: 'acceptance', name: 'a', how: { via: 'command', command: 'assert-gift-note-optional' } },
    ];
    const exec: RunCheckDeps['exec'] = async () => ({ ok: true, detail: null });
    const results = await runGeneratedChecks(specs, { http, exec });
    expect(computeVerdict(results)).toBe('verified');
  });
});
