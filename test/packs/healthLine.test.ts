import { describe, it, expect } from 'vitest';
import { healthLine } from '../../src/server/packs/healthLine.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('packs/healthLine', () => {
  it('reports down when serving_now.healthy is false', () => {
    expect(healthLine(makeTestPack({ state: { serving_now: { healthy: false } } }))).toBe('Looks down right now.');
  });

  it('surfaces a capability gap ahead of a bare "healthy"', () => {
    const pack = makeTestPack({
      state: { serving_now: { healthy: true } },
      topology: { sources: [], capability_gaps: [{ gap: 'checkout', summary: 'day 12 of visitors being unable to buy' }] },
    });
    expect(healthLine(pack)).toBe('Healthy — day 12 of visitors being unable to buy');
  });

  it('reports no signal yet when health is unknown and there are no gaps', () => {
    expect(healthLine(makeTestPack())).toBe('No health signal yet.');
  });

  it('hedges when overall_confidence is partial and health is unknown', () => {
    expect(healthLine(makeTestPack({ trust: { overall_confidence: 'partial' } }))).toMatch(/can't fully verify/);
  });

  it('discloses low confidence ahead of everything else', () => {
    expect(healthLine(makeTestPack({ trust: { overall_confidence: 'low' }, state: { serving_now: { healthy: true } } }))).toMatch(
      /can't verify/,
    );
  });

  it('reports healthy when true and there are no gaps', () => {
    expect(healthLine(makeTestPack({ state: { serving_now: { healthy: true } } }))).toBe('Healthy.');
  });
});
