import { describe, it, expect } from 'vitest';
import { pollDeployStates, type ServiceToPoll } from '../../../src/server/connectors/railway/poller.js';
import type { HostDeployStatus } from '../../../src/server/connectors/railway/client.js';
import type { NewSelvedgeEvent } from '../../../src/shared/types/event.js';

function svc(serviceId: string): ServiceToPoll {
  return {
    orgId: 'org_a',
    target: { projectId: 'p', environmentId: 'e', serviceId },
    token: 'tok',
    repoFullName: 'acme/loom',
  };
}

/** A harness that drives ticks with scripted states and captures ingested events. */
function harness(services: ServiceToPoll[]) {
  const lastState = new Map<string, HostDeployStatus>();
  const ingested: NewSelvedgeEvent[] = [];
  let script: Record<string, HostDeployStatus | null> = {};
  const now = () => new Date('2026-07-31T12:00:00Z');

  async function tick(states: Record<string, HostDeployStatus | null>) {
    script = states;
    ingested.length = 0;
    await pollDeployStates({
      db: {} as never,
      lastState,
      now,
      listServices: async () => services,
      getState: async (_t, target) => {
        const s = script[target.serviceId];
        return s === null || s === undefined ? null : { status: s };
      },
      ingest: async (e) => void ingested.push(e),
    });
    return ingested.map((e) => e.event_type);
  }

  return { tick, ingested };
}

describe('pollDeployStates — the running edge-triggered poller', () => {
  it('emits on the first real sighting, then stays silent while the state holds', async () => {
    const h = harness([svc('svc_1')]);
    expect(await h.tick({ svc_1: 'live' })).toEqual(['build.succeeded']); // first sight
    expect(await h.tick({ svc_1: 'live' })).toEqual([]); // unchanged → silent
    expect(await h.tick({ svc_1: 'live' })).toEqual([]);
  });

  it('emits a deploy failure only on the transition into failed', async () => {
    const h = harness([svc('svc_1')]);
    await h.tick({ svc_1: 'live' });
    expect(await h.tick({ svc_1: 'failed' })).toEqual(['deploy.failed_previous_serving']);
    expect(await h.tick({ svc_1: 'failed' })).toEqual([]); // still failed → no repeat
  });

  it('a blip we cannot read emits nothing, and the next real reading is first-sight (no phantom recovery)', async () => {
    const h = harness([svc('svc_1')]);
    await h.tick({ svc_1: 'live' });
    expect(await h.tick({ svc_1: null })).toEqual([]); // unreadable → unknown → silent
    // Coming back to 'live' after the blip is a success, NOT a recovery event.
    const back = await h.tick({ svc_1: 'live' });
    expect(back).toEqual(['build.succeeded']);
    expect(back.some((t) => t.includes('recover'))).toBe(false);
  });

  it('a read that throws is treated as unknown, never as a failure', async () => {
    const lastState = new Map<string, HostDeployStatus>([['svc_1', 'live']]);
    const ingested: NewSelvedgeEvent[] = [];
    await pollDeployStates({
      db: {} as never,
      lastState,
      listServices: async () => [svc('svc_1')],
      getState: async () => {
        throw new Error('railway down');
      },
      ingest: async (e) => void ingested.push(e),
    });
    expect(ingested).toEqual([]); // no fabricated failure
    expect(lastState.get('svc_1')).toBe('unknown'); // recorded as "don't know"
  });

  it('tracks services independently', async () => {
    const h = harness([svc('svc_1'), svc('svc_2')]);
    await h.tick({ svc_1: 'live', svc_2: 'building' });
    // svc_1 unchanged, svc_2 goes live — only svc_2 emits.
    const out = await h.tick({ svc_1: 'live', svc_2: 'live' });
    expect(out).toEqual(['build.succeeded']);
  });
});
