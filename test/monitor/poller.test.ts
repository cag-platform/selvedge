import { describe, it, expect } from 'vitest';
import { pollHealth, newMonitorState, type CheckToPoll } from '../../src/server/monitor/poller.js';
import type { ProbeResult } from '../../src/server/monitor/probe.js';
import type { NewSelvedgeEvent } from '../../src/shared/types/event.js';

function check(id: string, intervalSec = 60): CheckToPoll {
  return {
    orgId: 'org_a',
    sourceAccountId: 'acme/loom',
    intervalSec,
    spec: { id, kind: 'http', url: 'https://loom.example' },
  };
}

const up: ProbeResult = { up: true, latencyMs: 30, detail: null };
const down: ProbeResult = { up: false, latencyMs: 0, detail: 'the page returned 500' };

/** A harness that drives ticks with a scripted probe result and a controllable clock. */
function harness(checks: CheckToPoll[]) {
  const state = newMonitorState();
  let clockMs = 1_000_000;
  let nextResult: ProbeResult = up;

  async function tick(result: ProbeResult, advanceMs = 60_000): Promise<string[]> {
    nextResult = result;
    clockMs += advanceMs;
    const events: NewSelvedgeEvent[] = [];
    await pollHealth({
      db: {} as never,
      state,
      now: () => new Date(clockMs),
      listChecks: async () => checks,
      probe: async () => nextResult,
      ingest: async (e) => void events.push(e),
    });
    return events.map((e) => e.event_type);
  }

  return { tick, state };
}

describe('pollHealth — the running monitor', () => {
  it('two consecutive failing ticks announce the outage once; recovery announces once', async () => {
    const h = harness([check('c1')]);
    expect(await h.tick(down)).toEqual([]); // first failure — silent
    expect(await h.tick(down)).toEqual(['runtime.health_failing']); // second — announced
    expect(await h.tick(down)).toEqual([]); // still down — no repeat
    expect(await h.tick(up)).toEqual(['runtime.recovered']); // back up — announced once
    expect(await h.tick(up)).toEqual([]); // stays up — silent
  });

  it('a single-tick blip that clears never announces anything', async () => {
    const h = harness([check('c1')]);
    expect(await h.tick(down)).toEqual([]);
    expect(await h.tick(up)).toEqual([]);
  });

  it('respects the interval — a check is not re-run before its interval elapses', async () => {
    const h = harness([check('c1', 300)]); // 5-minute interval
    expect(await h.tick(down, 300_000)).toEqual([]); // runs (first)
    // Only 60s later — under the 300s interval, so it does NOT run again.
    expect(await h.tick(down, 60_000)).toEqual([]);
    // Now enough time has passed — it runs, second failure announces.
    expect(await h.tick(down, 300_000)).toEqual(['runtime.health_failing']);
  });

  it('tracks checks independently', async () => {
    const h = harness([check('c1'), check('c2')]);
    // Both fail once (silent), then c1 keeps failing while c2 recovers.
    await h.tick(down); // both first-fail (the harness returns the same result for all)
    // c1 and c2 both have 1 failure now; a second down announces BOTH.
    const out = await h.tick(down);
    expect(out.filter((e) => e === 'runtime.health_failing')).toHaveLength(2);
  });
});
