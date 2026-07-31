import type { ChangeSignals, RiskTier, GateLevel } from './types.js';

/**
 * Risk tiering — SILD's governance pattern applied to code (VIABILITY-REVIEW
 * accord §1). The tier is decided from what a change TOUCHES, before any work,
 * and it decides how much friction approval carries.
 *
 *   sensitive (payments / auth / user data) → hard gate + verified backup
 *   ordinary  (logic that is none of those) → normal approval
 *   cosmetic  (copy / styling only)         → near-frictionless
 *
 * The one asymmetry that matters: this fails SAFE. Any sensitive signal makes
 * the change sensitive, and `cosmeticOnly` is honored ONLY when no sensitive
 * signal is present — so a change mislabeled "just copy" that also touches auth
 * is still hard-gated. Under-gating a money/auth/data change is the unforgivable
 * miss; over-gating a cosmetic one merely costs a tap.
 */
export function classifyRisk(signals: ChangeSignals): RiskTier {
  if (signals.touchesPayments || signals.touchesAuth || signals.touchesUserData) {
    return 'sensitive';
  }
  if (signals.cosmeticOnly) {
    return 'cosmetic';
  }
  return 'ordinary';
}

/** The gate a tier demands. A fixed mapping, not a judgment call. */
export function gateFor(tier: RiskTier): GateLevel {
  switch (tier) {
    case 'sensitive':
      return 'hard';
    case 'ordinary':
      return 'normal';
    case 'cosmetic':
      return 'frictionless';
  }
}

/** Convenience: classify and gate in one step. */
export function assessRisk(signals: ChangeSignals): { risk: RiskTier; gate: GateLevel } {
  const risk = classifyRisk(signals);
  return { risk, gate: gateFor(risk) };
}
