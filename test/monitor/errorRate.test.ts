import { describe, it, expect } from 'vitest';
import {
  stepErrorRate,
  FRESH,
  WARMUP_WINDOWS,
  type ErrorRateState,
  type ErrorRateSample,
} from '../../src/server/monitor/errorRate.js';

const ctx = {
  orgId: 'org_1',
  sourceAccountId: 'acme/loom',
  sourceId: 'src_1',
  occurredAt: '2026-07-31T10:00:00Z',
};

function sample(rate: number): ErrorRateSample {
  return { rate, windowStartedAt: '2026-07-31T09:59:00Z' };
}

/** Feed a sequence of rates, returning the emitted event types and the final state. */
function run(rates: number[], start: ErrorRateState = FRESH) {
  let state = start;
  const events: string[] = [];
  for (const r of rates) {
    const step = stepErrorRate(state, sample(r), ctx);
    state = step.state;
    if (step.event) events.push(step.event.event_type);
  }
  return { events, state };
}

describe('stepErrorRate — baseline, floor, and the two-window debounce', () => {
  it('never announces while still warming up, however high the rate', () => {
    // Even a wild rate during warm-up is silent — we don't yet know normal.
    const { events, state } = run([0.5, 0.6, 0.5, 0.6, 0.5]);
    expect(events).toEqual([]);
    expect(state.windowsSeen).toBe(5);
    expect(state.baseline).toBeGreaterThan(0);
  });

  it('warming up is not "fine": no baseline means no verdict, not a false all-clear', () => {
    const { state } = run([0.01]);
    expect(state.windowsSeen).toBe(1);
    expect(state.windowsSeen).toBeLessThan(WARMUP_WINDOWS);
    // No event either way — silence, because we can't yet judge.
    expect(run([0.01]).events).toEqual([]);
  });

  it('a single elevated window after warm-up does not fire — one bad window is a blip', () => {
    // Warm a low baseline (~1% errors), then one elevated window.
    const warm = run([0.01, 0.01, 0.01, 0.01, 0.01]);
    const { events } = run([0.4], warm.state);
    expect(events).toEqual([]);
  });

  it('fires exactly once on the second consecutive elevated window, then stays silent', () => {
    const warm = run([0.01, 0.01, 0.01, 0.01, 0.01]);
    const { events, state } = run([0.4, 0.4, 0.4, 0.4], warm.state);
    expect(events).toEqual(['runtime.error_rate_spike']); // once, on the 2nd elevated window
    expect(state.alerted).toBe(true);
  });

  it('a spike never becomes the new normal — the baseline ignores elevated windows', () => {
    const warm = run([0.01, 0.01, 0.01, 0.01, 0.01]);
    const baselineBefore = warm.state.baseline!;
    const { state } = run([0.4, 0.4, 0.4, 0.4, 0.4], warm.state);
    // Baseline barely moved despite five 40%-error windows.
    expect(state.baseline).toBeLessThan(baselineBefore * 2);
  });

  it('after recovery a fresh spike can fire again (alerted clears silently, no recovery event)', () => {
    const warm = run([0.01, 0.01, 0.01, 0.01, 0.01]);
    const first = run([0.4, 0.4], warm.state); // fires
    expect(first.events).toEqual(['runtime.error_rate_spike']);
    const back = run([0.01, 0.01], first.state); // recovers — silent
    expect(back.events).toEqual([]);
    expect(back.state.alerted).toBe(false);
    const second = run([0.4, 0.4], back.state); // fires again
    expect(second.events).toEqual(['runtime.error_rate_spike']);
  });

  it('a high multiple below the absolute floor is never a spike', () => {
    // Baseline ~0.1%; a jump to 0.4% is 4× but still well under 5% — not news.
    const warm = run([0.001, 0.001, 0.001, 0.001, 0.001]);
    const { events } = run([0.004, 0.004, 0.004], warm.state);
    expect(events).toEqual([]);
  });

  it('the emitted event carries the rate, baseline, and multiple for the technical register', () => {
    const warm = run([0.02, 0.02, 0.02, 0.02, 0.02]);
    const step2 = stepErrorRate(stepErrorRate(warm.state, sample(0.5), ctx).state, sample(0.5), ctx);
    expect(step2.event).not.toBeNull();
    const raw = step2.event!.raw as { rate: number; baseline: number; multiple: number };
    expect(raw.rate).toBe(0.5);
    expect(raw.baseline).toBeGreaterThan(0);
    expect(raw.multiple).toBeGreaterThanOrEqual(3);
    expect(step2.event!.dedupe_key).toContain('src_1');
  });
});
