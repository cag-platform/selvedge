import { describe, it, expect } from 'vitest';
import { localDateString, localMidnightUtc, yesterdayBoundsUtc } from '../../src/server/digest/timezone.js';

describe('digest/timezone', () => {
  it('localDateString reflects the target timezone, not UTC', () => {
    // 2026-07-19T02:00:00Z is still 2026-07-18 in America/Los_Angeles (UTC-7 in July)
    expect(localDateString(new Date('2026-07-19T02:00:00Z'), 'America/Los_Angeles')).toBe('2026-07-18');
    expect(localDateString(new Date('2026-07-19T02:00:00Z'), 'UTC')).toBe('2026-07-19');
  });

  it('localMidnightUtc finds the correct UTC instant for local midnight, accounting for DST', () => {
    // July 19 2026 midnight in New York (EDT, UTC-4) is 04:00 UTC.
    const midnight = localMidnightUtc('America/New_York', 2026, 7, 19);
    expect(midnight.toISOString()).toBe('2026-07-19T04:00:00.000Z');
  });

  it('localMidnightUtc handles a UTC timezone trivially', () => {
    const midnight = localMidnightUtc('UTC', 2026, 7, 19);
    expect(midnight.toISOString()).toBe('2026-07-19T00:00:00.000Z');
  });

  it('yesterdayBoundsUtc returns a 24h window ending at today\'s local midnight', () => {
    const { start, end, dateString } = yesterdayBoundsUtc('America/New_York', new Date('2026-07-19T14:00:00Z'));
    expect(dateString).toBe('2026-07-18');
    expect(start.toISOString()).toBe('2026-07-18T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-19T04:00:00.000Z');
  });
});
