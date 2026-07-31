import { describe, it, expect } from 'vitest';
import { situationEdge, technicalPresentation } from '../../src/client/lib/situation.js';

/**
 * The situation card's two register-independent rules. The card is the surface
 * where the monitor's watching finally becomes visible, so these are the rules
 * that decide what a stranger reads from the edge — and they must never dress
 * an unclassified or unseen event as "fine".
 */
describe('situationEdge — a verdict always wins, and the fallback never fakes calm', () => {
  it('maps the fixed verdict vocabulary onto the edge', () => {
    expect(situationEdge({ verdict: 'users_affected', eventType: 'anything' })).toBe('needs');
    expect(situationEdge({ verdict: 'users_fine', eventType: 'anything' })).toBe('healthy');
    expect(situationEdge({ verdict: 'cannot_tell', eventType: 'anything' })).toBe('unknown');
  });

  it('without a verdict, a genuine down-signal reads as needs', () => {
    for (const t of ['runtime.health_failing', 'deploy.failed_nothing_serving', 'runtime.error_rate_spike']) {
      expect(situationEdge({ verdict: null, eventType: t })).toBe('needs');
    }
  });

  it('without a verdict, a recovery or success reads as healthy', () => {
    expect(situationEdge({ verdict: null, eventType: 'runtime.recovered' })).toBe('healthy');
    expect(situationEdge({ verdict: null, eventType: 'runtime.recovered_hidden_dependency' })).toBe('healthy');
    expect(situationEdge({ verdict: null, eventType: 'build.succeeded' })).toBe('healthy');
  });

  it('the signature "previous version still serving" failure is working, not thread-red', () => {
    // Users are fine — the old version keeps running — so it must not wear the
    // one edge reserved for "needs you".
    expect(situationEdge({ verdict: null, eventType: 'deploy.failed_previous_serving' })).toBe('working');
  });

  it('an unrecognised event defaults to working — never healthy', () => {
    // The false-calm rule at the surface: something happened, so never dress
    // the unknown as a clean bill of health.
    expect(situationEdge({ verdict: null, eventType: 'something.brand_new' })).toBe('working');
  });
});

describe('technicalPresentation — the register decides how the "why" rides along', () => {
  const line = 'HTTP 500 on GET / for 2 consecutive checks';

  it('plain_only never shows a technical line, even when one exists', () => {
    expect(technicalPresentation('plain_only', line)).toBe('absent');
  });

  it('plain_expandable collapses it behind a reveal', () => {
    expect(technicalPresentation('plain_expandable', line)).toBe('collapsed');
  });

  it('technical_forward shows it inline', () => {
    expect(technicalPresentation('technical_forward', line)).toBe('inline');
  });

  it('no technical line means nothing to show, at any register', () => {
    expect(technicalPresentation('technical_forward', null)).toBe('absent');
    expect(technicalPresentation('plain_expandable', '')).toBe('absent');
  });

  it('a missing register falls back to the expandable middle — the why stays reachable', () => {
    expect(technicalPresentation(null, line)).toBe('collapsed');
    expect(technicalPresentation(undefined, line)).toBe('collapsed');
  });
});
