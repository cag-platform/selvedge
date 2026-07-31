import { describe, it, expect } from 'vitest';
import { connectorAuthFailedNarration, unsortedTrayNarration } from '../../src/server/narration/orgLevel.js';
import { capabilityGapLine, quietProjectLine, weeklyRetrospectiveLine } from '../../src/server/narration/standing.js';
import { quietLine } from '../../src/server/digest/standing.js';
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

  it('capabilityGapLine claims "is healthy" ONLY when health is confirmed', () => {
    const gap = { gap: 'checkout', summary: 'day 12 of visitors being unable to buy' };

    const confirmed = makeTestPack({ state: { serving_now: { healthy: true } } });
    expect(capabilityGapLine(confirmed, gap)).toContain('is healthy');

    // No health signal at all — the old line asserted health regardless.
    const unseen = makeTestPack();
    expect(capabilityGapLine(unseen, gap)).not.toContain('healthy');
    expect(capabilityGapLine(unseen, gap)).toContain('day 12');

    // Actively down: never describe a down project as healthy.
    const down = makeTestPack({ state: { serving_now: { healthy: false } } });
    expect(capabilityGapLine(down, gap)).not.toContain('healthy');
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

describe('digest/standing quietLine — silence is not health', () => {
  const quiet = new Set<string>(); // nothing had activity today

  function pack(name: string, projectId: string, state: Record<string, unknown>, trust?: Record<string, unknown>) {
    return makeTestPack({
      identity: { name, project_id: projectId },
      stakes: { tier: 'live_critical' },
      state,
      ...(trust ? { trust } : {}),
    } as Parameters<typeof makeTestPack>[0]);
  }

  it('reassures only about projects whose health is confirmed', () => {
    const line = quietLine([pack('Mirror', 'p-mirror', { serving_now: { healthy: true } })], quiet);
    expect(line).toBe('Mirror was quiet and healthy.');
  });

  it('does NOT call a project healthy just because no events arrived', () => {
    // The regression this fix exists for: a live_critical project whose
    // connector died sends nothing, and was therefore reported as healthy.
    const line = quietLine([pack('SZD', 'p-szd', {})], quiet);
    expect(line).not.toContain('healthy');
    expect(line).toContain('SZD');
    expect(line).toContain("couldn't check");
  });

  it('separates the confirmed from the unverifiable in the same brief', () => {
    const line = quietLine(
      [
        pack('Mirror', 'p-mirror', { serving_now: { healthy: true } }),
        pack('SZD', 'p-szd', {}),
      ],
      quiet,
    );
    expect(line).toContain('Mirror was quiet and healthy.');
    expect(line).toContain("SZD was quiet, but I couldn't check it");
  });

  it('says nothing about projects that had activity today', () => {
    const active = new Set(['p-mirror']);
    expect(quietLine([pack('Mirror', 'p-mirror', { serving_now: { healthy: true } })], active)).toBe('');
  });

  it('leaves down projects to the attention lines rather than the quiet line', () => {
    const line = quietLine([pack('Loom', 'p-loom', { serving_now: { healthy: false } })], quiet);
    expect(line).toBe('');
  });
});
