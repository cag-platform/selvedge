import { describe, it, expect } from 'vitest';
import { classifyRisk, gateFor, assessRisk } from '../../src/server/cards/risk.js';

describe('classifyRisk — SILD tiers applied to code, failing safe', () => {
  it('any sensitive signal makes the change sensitive → hard gate', () => {
    for (const s of [{ touchesPayments: true }, { touchesAuth: true }, { touchesUserData: true }]) {
      expect(classifyRisk(s)).toBe('sensitive');
      expect(gateFor(classifyRisk(s))).toBe('hard');
    }
  });

  it('logic that touches none of those is ordinary → normal gate', () => {
    expect(classifyRisk({})).toBe('ordinary');
    expect(gateFor('ordinary')).toBe('normal');
  });

  it('copy/styling only is cosmetic → frictionless', () => {
    expect(classifyRisk({ cosmeticOnly: true })).toBe('cosmetic');
    expect(gateFor('cosmetic')).toBe('frictionless');
  });

  it('a change mislabeled "just copy" that also touches auth is STILL sensitive', () => {
    // The unforgivable miss is under-gating a money/auth/data change. cosmeticOnly
    // is honored only when no sensitive signal is present.
    expect(classifyRisk({ cosmeticOnly: true, touchesAuth: true })).toBe('sensitive');
    expect(classifyRisk({ cosmeticOnly: true, touchesPayments: true })).toBe('sensitive');
    expect(classifyRisk({ cosmeticOnly: true, touchesUserData: true })).toBe('sensitive');
  });

  it('assessRisk returns tier and gate together', () => {
    expect(assessRisk({ touchesPayments: true })).toEqual({ risk: 'sensitive', gate: 'hard' });
    expect(assessRisk({})).toEqual({ risk: 'ordinary', gate: 'normal' });
  });
});
