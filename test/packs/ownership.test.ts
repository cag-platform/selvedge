import { describe, it, expect } from 'vitest';
import { applyHumanPatch, applyMachinePatch } from '../../src/server/packs/ownership.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('packs/ownership', () => {
  it('human patch updates identity/stakes/voice/topology', () => {
    const pack = makeTestPack();
    const next = applyHumanPatch(pack, { identity: { name: 'Renamed' } as any, stakes: { touches_money: true } as any });
    expect(next.identity.name).toBe('Renamed');
    expect(next.stakes.touches_money).toBe(true);
    // untouched fields survive the shallow merge
    expect(next.identity.project_id).toBe(pack.identity.project_id);
  });

  it('machine patch appends a new source additively', () => {
    const pack = makeTestPack();
    const next = applyMachinePatch(pack, {
      addSources: [{ connector: 'railway', resource_id: 'svc-123', role: 'production_host' }],
    });
    expect(next.topology.sources).toHaveLength(2);
    expect(next.topology.sources.some((s) => s.connector === 'railway')).toBe(true);
  });

  it('machine patch does not duplicate an existing source', () => {
    const pack = makeTestPack();
    const existingSource = pack.topology.sources[0]!;
    const next = applyMachinePatch(pack, { addSources: [{ ...existingSource }] });
    expect(next.topology.sources).toHaveLength(1);
  });

  it('machine patch never mutates identity/stakes/voice', () => {
    const pack = makeTestPack();
    const next = applyMachinePatch(pack, { baselines: { deploy_cadence: 'daily' } });
    expect(next.identity).toBe(pack.identity);
    expect(next.stakes).toBe(pack.stakes);
    expect(next.voice).toBe(pack.voice);
    expect(next.baselines?.deploy_cadence).toBe('daily');
  });

  it('machine patch merges last_event_at_by_source per-connector key, not wholesale', () => {
    const pack = makeTestPack({ state: { last_event_at_by_source: { neon: '2026-01-01T00:00:00Z' } } });
    const next = applyMachinePatch(pack, { state: { last_event_at_by_source: { github: '2026-07-19T00:00:00Z' } } });
    expect(next.state?.last_event_at_by_source).toEqual({
      neon: '2026-01-01T00:00:00Z',
      github: '2026-07-19T00:00:00Z',
    });
  });

  it('machine patch merges state/trust shallowly', () => {
    const pack = makeTestPack();
    const next = applyMachinePatch(pack, {
      state: { serving_now: { version_ref: 'abc123', deployed_at: '2026-07-19T00:00:00Z', healthy: true } },
      trust: { overall_confidence: 'partial' },
    });
    expect(next.state?.serving_now?.version_ref).toBe('abc123');
    expect(next.trust?.overall_confidence).toBe('partial');
  });
});
