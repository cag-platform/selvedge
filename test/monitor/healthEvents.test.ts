import { describe, it, expect } from 'vitest';
import { stepHealth, HEALTHY, type HealthState } from '../../src/server/monitor/healthEvents.js';
import type { ProbeResult } from '../../src/server/monitor/probe.js';

const up: ProbeResult = { up: true, latencyMs: 40, detail: null };
const down: ProbeResult = { up: false, latencyMs: 0, detail: 'the page returned 500' };

const ctx = { orgId: 'org_a', sourceAccountId: 'acme/loom', checkId: 'chk_1', occurredAt: '2026-07-31T12:00:00Z' };

/** Feed a sequence of probe results through the state machine, collecting emitted event types. */
function run(results: ProbeResult[]): { events: (string | null)[]; final: HealthState } {
  let state = HEALTHY;
  const events: (string | null)[] = [];
  for (const r of results) {
    const step = stepHealth(state, r, ctx);
    state = step.state;
    events.push(step.event?.event_type ?? null);
  }
  return { events, final: state };
}

describe('stepHealth — the two-failure debounce', () => {
  it('a single failed probe does NOT announce an outage — a blip is silent', () => {
    const { events } = run([down]);
    expect(events).toEqual([null]);
  });

  it('a blip that clears on the next poll never pages', () => {
    const { events, final } = run([down, up]);
    expect(events).toEqual([null, null]);
    expect(final).toEqual(HEALTHY); // fully reset
  });

  it('announces the outage exactly once, on the SECOND consecutive failure', () => {
    const { events } = run([down, down, down, down]);
    expect(events).toEqual([null, 'runtime.health_failing', null, null]);
  });

  it('recovers only after it had actually announced the outage', () => {
    const { events } = run([down, down, up]);
    expect(events).toEqual([null, 'runtime.health_failing', 'runtime.recovered']);
  });

  it('does not emit a phantom recovery when it never announced an outage', () => {
    // down (1) then up — below threshold, so no failing event and no recovery.
    const { events } = run([down, up, up]);
    expect(events).toEqual([null, null, null]);
  });

  it('a full outage-and-recovery cycle, then a second one, both fire cleanly', () => {
    const { events } = run([down, down, up, down, down, up]);
    expect(events).toEqual([
      null,
      'runtime.health_failing',
      'runtime.recovered',
      null,
      'runtime.health_failing',
      'runtime.recovered',
    ]);
  });

  it('the failing event carries the failure count and detail for the technical register', () => {
    const first = stepHealth(HEALTHY, down, ctx);
    const second = stepHealth(first.state, down, ctx);
    expect(second.event?.event_type).toBe('runtime.health_failing');
    expect(second.event?.raw).toMatchObject({ consecutiveFailures: 2, detail: 'the page returned 500' });
  });

  it('never announces down on a single flake, however many isolated flakes occur', () => {
    // up, down, up, down, up — no two failures in a row → never fires.
    const { events } = run([up, down, up, down, up]);
    expect(events.every((e) => e === null)).toBe(true);
  });
});
