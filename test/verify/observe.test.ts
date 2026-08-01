import { describe, it, expect } from 'vitest';
import { observeDeploy, stepObservation, OBSERVE_FRESH, verdictAfterObservation, type ObserveDeps } from '../../src/server/verify/observe.js';
import type { ProbeResult } from '../../src/server/monitor/probe.js';

const up: ProbeResult = { up: true, latencyMs: 5, detail: null };
const down: ProbeResult = { up: false, latencyMs: 0, detail: 'the page returned 500' };

describe('stepObservation — the monitor two-failure debounce, reused', () => {
  it('a single failure does not break; a recovery resets the run', () => {
    let s = stepObservation(OBSERVE_FRESH, down);
    expect(s.broke).toBe(false);
    s = stepObservation(s.state, up); // recovered
    expect(s.state.consecutiveFailures).toBe(0);
  });

  it('two consecutive failures break', () => {
    const first = stepObservation(OBSERVE_FRESH, down);
    const second = stepObservation(first.state, down);
    expect(second.broke).toBe(true);
  });
});

/** A window harness: scripted probes, a controllable clock, no real waiting. */
function windowHarness(probes: Array<ProbeResult | 'throw'>, opts: { windowMs?: number; intervalMs?: number } = {}) {
  let i = 0;
  let clock = 0;
  const intervalMs = opts.intervalMs ?? 30_000;
  let rolledBack = false;
  const deps: ObserveDeps = {
    windowMs: opts.windowMs ?? 300_000,
    intervalMs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    probe: async () => {
      const p = probes[Math.min(i, probes.length - 1)];
      i++;
      if (p === 'throw') throw new Error('unreachable');
      return p;
    },
    rollback: async () => {
      rolledBack = true;
    },
  };
  return { deps, get rolledBack() { return rolledBack; }, get probeCount() { return i; } };
}

describe('observeDeploy — watch after ship, roll back on a real break', () => {
  it('holds when the app stays up across the window', async () => {
    const h = windowHarness([up], { windowMs: 100_000, intervalMs: 30_000 });
    const res = await observeDeploy(h.deps);
    expect(res.outcome).toBe('held');
    expect(res.rolledBack).toBe(false);
    expect(h.rolledBack).toBe(false);
  });

  it('rolls back on the second consecutive failure, and probes no further', async () => {
    const h = windowHarness([up, down, down, up, up]);
    const res = await observeDeploy(h.deps);
    expect(res.outcome).toBe('broke');
    expect(res.rolledBack).toBe(true);
    expect(h.probeCount).toBe(3); // stopped at the 2nd failure, didn't keep going
  });

  it('a single failure that recovers never rolls back', async () => {
    const h = windowHarness([up, down, up, up], { windowMs: 100_000, intervalMs: 30_000 });
    const res = await observeDeploy(h.deps);
    expect(res.outcome).toBe('held');
    expect(h.rolledBack).toBe(false);
  });

  it('an unreachable app counts as failure — two in a row rolls back', async () => {
    const h = windowHarness(['throw', 'throw']);
    const res = await observeDeploy(h.deps);
    expect(res.outcome).toBe('broke');
    expect(h.rolledBack).toBe(true);
  });
});

describe('verdictAfterObservation — production is the last word', () => {
  it('a change that broke prod is didnt_work, and says it was rolled back', () => {
    const r = verdictAfterObservation('verified', { outcome: 'broke', rolledBack: true, samples: 3 });
    expect(r.verdict).toBe('didnt_work');
    expect(r.summary).toMatch(/rolled it (straight )?back/i);
  });

  it('holding leaves the pre-deploy verdict untouched — probably stays probably', () => {
    expect(verdictAfterObservation('probably', { outcome: 'held', rolledBack: false, samples: 5 }).verdict).toBe('probably');
    expect(verdictAfterObservation('verified', { outcome: 'held', rolledBack: false, samples: 5 }).verdict).toBe('verified');
  });
});
