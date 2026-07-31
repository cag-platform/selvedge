import { describe, it, expect } from 'vitest';
import { pollDeployStates, type ServiceToPoll } from '../../../src/server/connectors/host/poller.js';
import type { HostDeployStatus } from '../../../src/server/connectors/host/deploy.js';
import type { NewSelvedgeEvent } from '../../../src/shared/types/event.js';

/**
 * A harness that drives ticks with scripted states per service and captures
 * ingested events. Each service's `read` is bound to the current script.
 */
function harness(services: Array<{ serviceId: string; source: 'railway' | 'vercel' }>) {
  const lastState = new Map<string, HostDeployStatus>();
  const ingested: NewSelvedgeEvent[] = [];
  let script: Record<string, HostDeployStatus | null> = {};
  const now = () => new Date('2026-07-31T12:00:00Z');

  const toPoll: ServiceToPoll[] = services.map((s) => ({
    orgId: 'org_a',
    projectId: 'loom',
    source: s.source,
    serviceId: s.serviceId,
    repoFullName: 'acme/loom',
    read: async () => {
      const v = script[s.serviceId];
      return v === null || v === undefined ? null : { status: v };
    },
  }));

  async function tick(states: Record<string, HostDeployStatus | null>) {
    script = states;
    ingested.length = 0;
    await pollDeployStates({
      db: {} as never,
      lastState,
      now,
      listServices: async () => toPoll,
      ingest: async (e) => void ingested.push(e),
    });
    return ingested;
  }

  return { tick, lastState };
}

describe('pollDeployStates — host-agnostic edge-triggered poller', () => {
  it('emits on the first real sighting, then stays silent while the state holds', async () => {
    const h = harness([{ serviceId: 'svc_1', source: 'railway' }]);
    expect((await h.tick({ svc_1: 'live' })).map((e) => e.event_type)).toEqual(['build.succeeded']);
    expect(await h.tick({ svc_1: 'live' })).toEqual([]);
  });

  it('emits a deploy failure only on the transition into failed, carrying the host source', async () => {
    const h = harness([{ serviceId: 'svc_1', source: 'vercel' }]);
    await h.tick({ svc_1: 'live' });
    const out = await h.tick({ svc_1: 'failed' });
    expect(out.map((e) => e.event_type)).toEqual(['deploy.failed_previous_serving']);
    expect(out[0]!.source).toBe('vercel');
    expect(await h.tick({ svc_1: 'failed' })).toEqual([]);
  });

  it('a blip we cannot read emits nothing, and the next real reading is first-sight (no phantom recovery)', async () => {
    const h = harness([{ serviceId: 'svc_1', source: 'railway' }]);
    await h.tick({ svc_1: 'live' });
    expect(await h.tick({ svc_1: null })).toEqual([]);
    const back = await h.tick({ svc_1: 'live' });
    expect(back.map((e) => e.event_type)).toEqual(['build.succeeded']);
    expect(back.some((e) => e.event_type.includes('recover'))).toBe(false);
  });

  it('a read that throws is treated as unknown, never as a failure', async () => {
    const lastState = new Map<string, HostDeployStatus>([['railway:svc_1', 'live']]);
    const ingested: NewSelvedgeEvent[] = [];
    await pollDeployStates({
      db: {} as never,
      lastState,
      listServices: async () => [
        { orgId: 'o', projectId: 'p', source: 'railway', serviceId: 'svc_1', repoFullName: 'acme/loom', read: async () => { throw new Error('down'); } },
      ],
      ingest: async (e) => void ingested.push(e),
    });
    expect(ingested).toEqual([]);
    expect(lastState.get('railway:svc_1')).toBe('unknown');
  });

  it('tracks two hosts independently, even with the same service id', async () => {
    const h = harness([
      { serviceId: 'svc', source: 'railway' },
      { serviceId: 'svc', source: 'vercel' },
    ]);
    // Both first-sighted live → two successes (keys are host-namespaced).
    const out = await h.tick({ svc: 'live' });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((e) => e.source))).toEqual(new Set(['railway', 'vercel']));
  });
});
