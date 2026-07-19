import { describe, it, expect } from 'vitest';
import { connectorAuthFailedNarration, unsortedTrayNarration } from '../../src/server/narration/orgLevel.js';
import { capabilityGapLine, quietProjectLine, weeklyRetrospectiveLine } from '../../src/server/narration/standing.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('narration/orgLevel', () => {
  it('connectorAuthFailedNarration names the connector and carries cannot_tell', () => {
    const output = connectorAuthFailedNarration('GitHub');
    expect(output.fragment).toContain('GitHub');
    expect(output.verdict).toBe('cannot_tell');
  });

  it('unsortedTrayNarration pluralizes correctly', () => {
    expect(unsortedTrayNarration(1).fragment).toContain('1 event ');
    expect(unsortedTrayNarration(3).fragment).toContain('3 events');
  });
});

describe('narration/standing', () => {
  it('capabilityGapLine uses the pack name and the gap summary', () => {
    const pack = makeTestPack();
    const line = capabilityGapLine(pack, { gap: 'checkout', summary: "day 12 of visitors being unable to buy" });
    expect(line).toContain(pack.identity.name);
    expect(line).toContain('day 12');
  });

  it('quietProjectLine handles zero, one, two, and many names', () => {
    expect(quietProjectLine([])).toBe('');
    expect(quietProjectLine(['Mirror'])).toBe('Mirror was quiet and healthy.');
    expect(quietProjectLine(['Mirror', 'Toile'])).toBe('Mirror and Toile were quiet and healthy.');
    expect(quietProjectLine(['Mirror', 'Toile', 'CAG'])).toBe('Mirror, Toile and CAG were quiet and healthy.');
  });

  it('weeklyRetrospectiveLine composes only the non-zero counts', () => {
    expect(weeklyRetrospectiveLine({ shipped: 3, moved: 1, stalled: 0 })).toBe(
      'This week you shipped 3 updates, moved 1 thing forward.',
    );
    expect(weeklyRetrospectiveLine({ shipped: 0, moved: 0, stalled: 0 })).toBe('This week was quiet across the board.');
  });
});
