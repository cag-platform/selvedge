import { describe, it, expect } from 'vitest';
import { correlateChange, isBreakEvent, isChangeEvent, type ChangeCandidate } from '../../src/server/resolution/correlate.js';

const BREAK_AT = new Date('2026-07-31T12:00:00Z');

function change(eventType: string, minutesBefore: number, id = eventType): ChangeCandidate {
  return { eventId: id, eventType, occurredAt: new Date(BREAK_AT.getTime() - minutesBefore * 60000) };
}

describe('correlateChange — a lead, never a fabricated culprit', () => {
  it('lines a break up against the change just before it', () => {
    const c = correlateChange('runtime.health_failing', BREAK_AT, [change('code.commits_landed_default', 20)]);
    expect(c).not.toBeNull();
    expect(c!.changeType).toBe('code.commits_landed_default');
    expect(c!.minutesBefore).toBe(20);
    expect(c!.plain).toMatch(/started/i);
    expect(c!.plain).toMatch(/worth checking first/i);
  });

  it('never claims proven cause — the technical line carries the caveat', () => {
    const c = correlateChange('runtime.error_rate_spike', BREAK_AT, [change('build.succeeded', 5)]);
    expect(c!.technical).toMatch(/not a confirmed cause/i);
  });

  it('picks the CLOSEST change before the break, not the earliest', () => {
    const c = correlateChange('runtime.health_failing', BREAK_AT, [
      change('code.commits_landed_default', 50, 'old'),
      change('build.succeeded', 8, 'recent'),
    ]);
    expect(c!.changeEventId).toBe('recent');
  });

  it('returns null when nothing shipped in the window — no reaching back for a suspect', () => {
    const c = correlateChange('runtime.health_failing', BREAK_AT, [change('code.commits_landed_default', 90)]);
    expect(c).toBeNull();
  });

  it('ignores changes that land AFTER the break', () => {
    const after: ChangeCandidate = {
      eventId: 'after',
      eventType: 'build.succeeded',
      occurredAt: new Date(BREAK_AT.getTime() + 5 * 60000),
    };
    expect(correlateChange('runtime.health_failing', BREAK_AT, [after])).toBeNull();
  });

  it('ignores non-change events in the window (a PR opening is not a change to prod)', () => {
    const c = correlateChange('runtime.health_failing', BREAK_AT, [
      { eventId: 'pr', eventType: 'code.pr_opened', occurredAt: new Date(BREAK_AT.getTime() - 10 * 60000) },
    ]);
    expect(c).toBeNull();
  });

  it('does nothing for a non-break event, even with a change present', () => {
    expect(correlateChange('code.pr_opened', BREAK_AT, [change('build.succeeded', 5)])).toBeNull();
  });

  it('rounds sub-two-minute proximity to "moments after"', () => {
    const c = correlateChange('runtime.health_failing', BREAK_AT, [change('build.succeeded', 1)]);
    expect(c!.plain).toMatch(/moments after/i);
  });

  it('classifies break and change vocabularies', () => {
    expect(isBreakEvent('runtime.health_failing')).toBe(true);
    expect(isBreakEvent('deploy.failed_nothing_serving')).toBe(true);
    expect(isBreakEvent('code.pr_opened')).toBe(false);
    expect(isChangeEvent('build.succeeded')).toBe(true);
    expect(isChangeEvent('runtime.health_failing')).toBe(false);
  });
});
