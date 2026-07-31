import { describe, it, expect } from 'vitest';
import { requestSignals, incidentSignals, incidentWorthCard, incidentProposal, defaultEstimateAndCap } from '../../src/server/cards/triggers.js';
import { classifyRisk } from '../../src/server/cards/risk.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('requestSignals — a deterministic, escalate-only floor', () => {
  it('escalates on payment, auth, and user-data keywords', () => {
    expect(classifyRisk(requestSignals('add a stripe checkout'))).toBe('sensitive');
    expect(classifyRisk(requestSignals('let people log in with Google'))).toBe('sensitive');
    expect(classifyRisk(requestSignals('let users export their profile data'))).toBe('sensitive');
  });

  it("escalates on the owner's own declaration even when no keyword matches", () => {
    expect(classifyRisk(requestSignals('tweak the thing', { touchesPayments: true }))).toBe('sensitive');
  });

  it('reads a clearly cosmetic request as cosmetic', () => {
    expect(classifyRisk(requestSignals('change the button colour and heading font'))).toBe('cosmetic');
  });

  it('a sensitive keyword beats a cosmetic one — never downgraded', () => {
    // "colour" is cosmetic, but "checkout" is sensitive; sensitive wins.
    expect(classifyRisk(requestSignals('change the checkout button colour'))).toBe('sensitive');
  });

  it('defaults to ordinary when nothing matches', () => {
    expect(classifyRisk(requestSignals('make the gift note optional'))).toBe('ordinary');
  });
});

describe('incident triggers — pack-derived, safe by default', () => {
  const moneyPack = makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'a shop' },
    stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
  });
  const sandboxPack = makeTestPack({
    identity: { project_id: 'toy', name: 'Toy', owner_description: 'x' },
    stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
  });

  it('only offers a fix card for live apps', () => {
    expect(incidentWorthCard(moneyPack)).toBe(true);
    expect(incidentWorthCard(sandboxPack)).toBe(false);
  });

  it('a fix to a money-touching app is payment-sensitive', () => {
    expect(classifyRisk(incidentSignals(moneyPack))).toBe('sensitive');
  });

  it('names the problem in plain words, by what broke', () => {
    expect(incidentProposal(moneyPack, 'runtime.health_failing').title).toMatch(/down/i);
    expect(incidentProposal(moneyPack, 'runtime.error_rate_spike').proposal).toMatch(/errors/i);
    expect(incidentProposal(moneyPack, 'data.migration_failed').proposal).toMatch(/backup/i);
  });

  it('gives a finite, non-zero cap by tier', () => {
    expect(defaultEstimateAndCap('live_small').capCents).toBeGreaterThan(0);
    expect(defaultEstimateAndCap('live_critical').capCents).toBeGreaterThan(defaultEstimateAndCap('live_small').capCents);
  });
});
