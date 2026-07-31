import { describe, it, expect } from 'vitest';
import { pollErrorRates, type ErrorSourceToPoll } from '../../src/server/monitor/errorPoller.js';
import type { ErrorRateState, ErrorRateSample } from '../../src/server/monitor/errorRate.js';
import type { NewSelvedgeEvent } from '../../src/shared/types/event.js';

function src(sourceId: string): ErrorSourceToPoll {
  return { orgId: 'org_a', projectId: 'loom', sourceId, repoFullName: 'acme/loom' };
}

/** Drives ticks with scripted per-source rates (null = unreadable) and captures ingested events. */
function harness(sources: ErrorSourceToPoll[]) {
  const state = new Map<string, ErrorRateState>();
  const ingested: Array<{ event: NewSelvedgeEvent; projectId: string }> = [];
  let script: Record<string, number | null> = {};

  async function tick(rates: Record<string, number | null>) {
    script = rates;
    ingested.length = 0;
    await pollErrorRates({
      db: {} as never,
      state,
      now: () => new Date('2026-07-31T12:00:00Z'),
      listSources: async () => sources,
      readSample: async (s): Promise<ErrorRateSample | null> => {
        const r = script[s.sourceId];
        return r === null || r === undefined ? null : { rate: r, windowStartedAt: '2026-07-31T11:59:00Z' };
      },
      ingest: async (event, projectId) => void ingested.push({ event, projectId }),
    });
    return ingested;
  }

  return { tick };
}

describe('pollErrorRates — the running error-rate loop', () => {
  it('warms a baseline, then ingests one spike against the right project on the second elevated window', async () => {
    const h = harness([src('src_1')]);
    for (let i = 0; i < 5; i++) expect(await h.tick({ src_1: 0.01 })).toHaveLength(0); // warm-up, silent
    expect(await h.tick({ src_1: 0.4 })).toHaveLength(0); // first elevated — a blip, silent
    const out = await h.tick({ src_1: 0.4 }); // second elevated — announced
    expect(out).toHaveLength(1);
    expect(out[0]!.event.event_type).toBe('runtime.error_rate_spike');
    expect(out[0]!.projectId).toBe('loom'); // placed against the project, no source resolution
  });

  it('a read it cannot make is silent and breaks the run — no spike is manufactured across a blind window', async () => {
    const h = harness([src('src_1')]);
    for (let i = 0; i < 5; i++) await h.tick({ src_1: 0.01 }); // warm
    await h.tick({ src_1: 0.4 }); // one elevated
    expect(await h.tick({ src_1: null })).toHaveLength(0); // can't read → gap, resets the run
    // The next elevated window is only the first observed one again — no fire.
    expect(await h.tick({ src_1: 0.4 })).toHaveLength(0);
    // …and the one after it fires, proving the loop keeps working after a gap.
    expect(await h.tick({ src_1: 0.4 })).toHaveLength(1);
  });

  it('a read that throws is treated as a gap, never as a spike', async () => {
    const state = new Map<string, ErrorRateState>();
    const ingested: NewSelvedgeEvent[] = [];
    await pollErrorRates({
      db: {} as never,
      state,
      listSources: async () => [src('src_1')],
      readSample: async () => {
        throw new Error('log tail down');
      },
      ingest: async (e) => void ingested.push(e),
    });
    expect(ingested).toEqual([]);
  });

  it('tracks sources independently', async () => {
    const h = harness([src('src_1'), src('src_2')]);
    for (let i = 0; i < 5; i++) await h.tick({ src_1: 0.01, src_2: 0.01 });
    await h.tick({ src_1: 0.4, src_2: 0.01 }); // only src_1 elevated
    const out = await h.tick({ src_1: 0.4, src_2: 0.01 });
    expect(out).toHaveLength(1);
    expect(out[0]!.event.source_account_id).toBe('acme/loom');
  });
});
