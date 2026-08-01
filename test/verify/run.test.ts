import { describe, it, expect } from 'vitest';
import { verifyCard, type VerifyDeps } from '../../src/server/verify/run.js';
import { advance, type CardAction } from '../../src/server/cards/machine.js';
import { proposeCard } from '../../src/server/cards/propose.js';
import type { Card } from '../../src/server/cards/types.js';
import type { CheckResult } from '../../src/server/verify/verdict.js';

const T = '2026-08-01T12:00:00Z';
const smoke = (o: CheckResult['outcome']): CheckResult => ({ kind: 'smoke', name: 'responds', outcome: o });
const acceptance = (o: CheckResult['outcome']): CheckResult => ({ kind: 'acceptance', name: 'does what was asked', outcome: o });

/** A card driven to `verifying`, the state verification acts on. */
function verifyingCard(): Card {
  let c = proposeCard({
    id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'x', proposal: 'x',
    signals: {}, estimate: { lowCents: 100, highCents: 500 }, capCents: 100000, now: T,
  });
  for (const a of [
    { type: 'approve', at: T },
    { type: 'start_work', at: T },
    { type: 'begin_verify', at: T },
  ] as CardAction[]) {
    const r = advance(c, a);
    if (!r.ok) throw new Error('setup');
    c = r.card;
  }
  return c;
}

function harness(card: Card, runChecks: VerifyDeps['runChecks']) {
  let current = card;
  const deps: VerifyDeps = {
    now: () => new Date(T),
    apply: async (action: CardAction) => {
      const r = advance(current, action);
      if (r.ok) current = r.card;
      return r.ok ? { ok: true, card: r.card } : { ok: false, error: r.error };
    },
    runChecks,
  };
  return { deps, getCard: () => current };
}

describe('verifyCard — checks in, an honest verdict onto the card', () => {
  it('a confirmed change completes as verified, with the summary on the card', async () => {
    const h = harness(verifyingCard(), async () => [smoke('pass'), acceptance('pass')]);
    const res = await verifyCard(h.deps, h.getCard());
    expect(res.outcome).toBe('completed');
    expect(res.card.state).toBe('done');
    expect(res.card.verdict).toBe('verified');
    const act = res.card.acts.at(-1)!;
    expect(act.kind).toBe('completed');
    expect(act.detail).toMatch(/verified/i); // the honest summary, not a bare label
    expect((act.meta as { results?: unknown }).results).toBeTruthy();
  });

  it('a failing check completes as didnt_work — never shipped as fine', async () => {
    const h = harness(verifyingCard(), async () => [smoke('pass'), acceptance('fail')]);
    const res = await verifyCard(h.deps, h.getCard());
    expect(res.card.verdict).toBe('didnt_work');
  });

  it('checks that could not be run land at inconclusive, not verified', async () => {
    const h = harness(verifyingCard(), async () => [smoke('could_not_run')]);
    const res = await verifyCard(h.deps, h.getCard());
    expect(res.card.verdict).toBe('inconclusive');
  });

  it('a verifier that throws is inconclusive — never a hidden pass, never a crash', async () => {
    const h = harness(verifyingCard(), async () => {
      throw new Error('sandbox gone');
    });
    const res = await verifyCard(h.deps, h.getCard());
    expect(res.outcome).toBe('completed');
    expect(res.card.verdict).toBe('inconclusive');
  });

  it('refuses a card that is not in verifying — runs no checks', async () => {
    const proposed = proposeCard({
      id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'x', proposal: 'x',
      signals: {}, estimate: { lowCents: 1, highCents: 2 }, capCents: 1000, now: T,
    });
    let ran = false;
    const h = harness(proposed, async () => { ran = true; return [smoke('pass')]; });
    const res = await verifyCard(h.deps, proposed);
    expect(res.outcome).toBe('not_verifiable');
    expect(ran).toBe(false);
  });
});
