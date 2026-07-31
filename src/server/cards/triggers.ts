import type { ContextPack, StakesTier } from '../../shared/types/pack.js';
import type { ChangeSignals, CostEstimate } from './types.js';

/**
 * The two front-ends of the loop. Both mint the SAME card; they differ only in
 * where the proposal and the risk signals come from.
 *
 *   incident — Selvedge raises it from a break it can offer to fix. Signals are
 *              derived from the pack (structured facts), never guessed.
 *   request  — the owner asks in free text. Signals come from a deterministic
 *              safety floor: a keyword scan and the owner's own declaration,
 *              both ESCALATE-ONLY. A request is never silently downgraded below
 *              what either source flags.
 *
 * Honest limitation, stated where it lives: keyword classification can miss a
 * sensitive change phrased without its keywords. The owner is always in the
 * approval loop, and richer LLM scoping will strengthen this later — but the
 * floor never DOWN-grades, so the failure mode is an over-gated ordinary change
 * (a wasted tap), never an under-gated sensitive one slipping to frictionless.
 */

const LIVE_TIERS = new Set<StakesTier>(['live_small', 'live_critical']);

/** Whether an incident on this app is worth offering a fix card for at all. */
export function incidentWorthCard(pack: ContextPack): boolean {
  // Only live apps get proactive fix proposals; a sandbox break is noise.
  return LIVE_TIERS.has(pack.stakes.tier);
}

/**
 * Signals for an incident fix, from the pack. A fix to a money-touching app is
 * treated as payment-sensitive — the owner SHOULD have a verified backup before
 * their checkout is changed. That is the safe default, not an over-reach.
 */
export function incidentSignals(pack: ContextPack): ChangeSignals {
  return { touchesPayments: pack.stakes.touches_money === true };
}

/** The plain-English proposal for an incident, by what broke. No jargon. */
export function incidentProposal(pack: ContextPack, eventType: string): { title: string; proposal: string } {
  const name = pack.identity.name;
  switch (eventType) {
    case 'runtime.health_failing':
      return {
        title: `Look into why ${name} is down`,
        proposal: `${name} looks down right now. I can investigate what changed and propose a fix. You'll approve the actual change before anything ships.`,
      };
    case 'runtime.error_rate_spike':
      return {
        title: `Look into the errors on ${name}`,
        proposal: `${name} is throwing more errors than usual. I can find what's failing and propose a fix — nothing ships without your approval.`,
      };
    case 'deploy.failed_previous_serving':
    case 'deploy.failed_nothing_serving':
      return {
        title: `Get ${name}'s latest update to deploy`,
        proposal: `${name}'s last deploy didn't go through. I can find why the build failed and propose a fix. You'll approve before anything ships.`,
      };
    case 'data.migration_failed':
      return {
        title: `Sort out the failed database change on ${name}`,
        proposal: `A database change on ${name} didn't finish cleanly. I can check what state it's in and propose a safe fix — this one always needs a verified backup first.`,
      };
    default:
      return {
        title: `Look into a problem on ${name}`,
        proposal: `Something went wrong on ${name}. I can investigate and propose a fix, with your approval before anything ships.`,
      };
  }
}

const PAYMENT_RE = /\b(pay|payment|payments|checkout|charge|billing|invoice|pricing|refund|stripe|paypal|subscription)\b/i;
const AUTH_RE = /\b(auth|login|log ?in|sign ?in|sign ?up|password|session|oauth|permission|permissions|access control|2fa|mfa)\b/i;
const USERDATA_RE = /\b(user data|customer data|personal data|profile|account|accounts|email address|gdpr|pii|delete .*account|export .*data)\b/i;
const COSMETIC_RE = /\b(colou?r|font|fonts|styling|css|spacing|margin|padding|logo|wording|copy|label|labels|placeholder|heading|headline)\b/i;

/** Owner's own sensitivity declaration — escalate-only, never a downgrade. */
export type OwnerTouches = {
  touchesPayments?: boolean;
  touchesAuth?: boolean;
  touchesUserData?: boolean;
};

/**
 * Derive risk signals for a free-text request. The union of a keyword scan and
 * the owner's declaration; cosmetic is honored ONLY when nothing sensitive is
 * found by either. Escalate-only by construction.
 */
export function requestSignals(text: string, owner: OwnerTouches = {}): ChangeSignals {
  const touchesPayments = owner.touchesPayments === true || PAYMENT_RE.test(text);
  const touchesAuth = owner.touchesAuth === true || AUTH_RE.test(text);
  const touchesUserData = owner.touchesUserData === true || USERDATA_RE.test(text);

  if (touchesPayments || touchesAuth || touchesUserData) {
    return { touchesPayments, touchesAuth, touchesUserData };
  }
  // Nothing sensitive found — cosmetic only if it clearly reads as copy/styling.
  if (COSMETIC_RE.test(text)) return { cosmeticOnly: true };
  return {};
}

/**
 * A placeholder estimate and cap until the Phase-5 ledger learns each project's
 * real per-failure-class costs. Conservative and finite: the cap is the safety
 * number, and it is never zero. Marked clearly so the estimate can be honest
 * ("a rough default — I'll sharpen this as I learn this project").
 */
export function defaultEstimateAndCap(tier: StakesTier): { estimate: CostEstimate; capCents: number } {
  // Critical apps tend to need more careful, larger work; give a little headroom.
  const critical = tier === 'live_critical';
  return {
    estimate: { lowCents: 300, highCents: critical ? 2000 : 1200 },
    capCents: critical ? 5000 : 3000,
  };
}
