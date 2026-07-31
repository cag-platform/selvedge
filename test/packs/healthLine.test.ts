import { describe, it, expect } from 'vitest';
import { healthLine, edgeStatus, deriveProjectStatus } from '../../src/server/packs/healthLine.js';
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

describe('packs/edgeStatus + healthLine agree (one source of truth)', () => {
  // The edge color and the sentence derive from deriveProjectStatus, so they
  // can never tell different stories. These are the cases that used to diverge.
  const cases: Array<{ name: string; pack: Parameters<typeof healthLine>[0]; edge: string }> = [
    {
      name: 'gap + healthy → working (not a green "healthy" edge)',
      pack: makeTestPack({ state: { serving_now: { healthy: true } }, topology: { sources: [], capability_gaps: [{ gap: 'checkout', summary: 'day 12 of visitors being unable to buy' }] } }),
      edge: 'working',
    },
    {
      name: 'gap + no health signal → working, gap surfaced without a false "Healthy"',
      pack: makeTestPack({ topology: { sources: [], capability_gaps: [{ gap: 'checkout', summary: 'day 12 of visitors being unable to buy' }] } }),
      edge: 'working',
    },
    {
      name: 'partial + healthy → unknown (never a bare "Healthy.")',
      pack: makeTestPack({ trust: { overall_confidence: 'partial' }, state: { serving_now: { healthy: true } } }),
      edge: 'unknown',
    },
    {
      name: 'in progress, healthy, no gap → working',
      pack: makeTestPack({ state: { serving_now: { healthy: true }, in_progress: [{ ref: 'pr-1', summary: 'refactor' }] } }),
      edge: 'working',
    },
    {
      name: 'down → needs',
      pack: makeTestPack({ state: { serving_now: { healthy: false } } }),
      edge: 'needs',
    },
    {
      name: 'no signal, no gap → unknown',
      pack: makeTestPack(),
      edge: 'unknown',
    },
  ];

  const expectedSentence: Record<string, RegExp> = {
    healthy: /^Healthy\.?/,
    working: /Healthy — |work in progress|day 12/,
    needs: /down|needs/i,
    unknown: /can't|no health signal/i,
  };

  for (const c of cases) {
    it(c.name, () => {
      const status = deriveProjectStatus(c.pack);
      expect(edgeStatus(c.pack)).toBe(c.edge);
      expect(status).toBe(c.edge);
      // The sentence must be consistent with the very same status.
      expect(healthLine(c.pack)).toMatch(expectedSentence[status]!);
    });
  }

  it('a partial+healthy project no longer shows a bare "Healthy." with an unknown edge', () => {
    const pack = makeTestPack({ trust: { overall_confidence: 'partial' }, state: { serving_now: { healthy: true } } });
    expect(edgeStatus(pack)).toBe('unknown');
    expect(healthLine(pack)).toMatch(/can't fully verify/);
  });
});
