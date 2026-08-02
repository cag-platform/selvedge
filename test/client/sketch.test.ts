import { describe, it, expect } from 'vitest';
import { budgetNote, canBuild, formatUsd, sketchStatus } from '../../src/client/lib/sketch.js';

describe('canBuild — the button never builds nothing', () => {
  it('offers the handoff only when there is a real brief behind it', () => {
    expect(canBuild({ ready: true, brief: 'Add a Cancel button.' })).toBe(true);
  });

  it('refuses on a ready flag with no brief, or a blank one', () => {
    expect(canBuild({ ready: true, brief: null })).toBe(false);
    expect(canBuild({ ready: true, brief: '   ' })).toBe(false);
  });

  it('refuses a brief that is not yet declared ready', () => {
    expect(canBuild({ ready: false, brief: 'a half-formed thought' })).toBe(false);
  });
});

describe('sketchStatus — where an idea has got to, in one word', () => {
  it('reads as thinking until it is settled', () => {
    expect(sketchStatus({ ready: false, handed_off_at: null })).toBe('Thinking');
  });

  it('says ready once there is something to build', () => {
    expect(sketchStatus({ ready: true, handed_off_at: null })).toBe('Ready to build');
  });

  it('once sent, it is building — even though it is also still ready', () => {
    expect(sketchStatus({ ready: true, handed_off_at: '2026-08-02T10:00:00Z' })).toBe('Building');
  });
});

describe('budgetNote — the cost watch stays quiet rather than lying', () => {
  it('says what has been spent against the day\'s allowance', () => {
    expect(budgetNote({ today_usd: 0.34, cap_usd: 2 })).toBe('$0.34 of $2.00 today');
  });

  it('says nothing when the lookup degraded to zeros — "$0.00 of $0.00" would be a lie', () => {
    expect(budgetNote({ today_usd: 0, cap_usd: 0 })).toBeNull();
    expect(budgetNote({ today_usd: 0, cap_usd: Number.NaN })).toBeNull();
  });
});

describe('formatUsd — cents matter when the whole point is that it is cheap', () => {
  it('keeps two places', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.017)).toBe('$0.02');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('never renders NaN at a customer', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });
});
