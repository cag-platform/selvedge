import { describe, it, expect } from 'vitest';
import { proposeCard } from '../../src/server/cards/propose.js';
import { advance, type CardAction } from '../../src/server/cards/machine.js';
import type { Card, ChangeSignals } from '../../src/server/cards/types.js';

const T = '2026-07-31T12:00:00Z';

function card(overrides: { signals?: ChangeSignals; capCents?: number; checkpointAtFractions?: number[] } = {}): Card {
  return proposeCard({
    id: 'card_1',
    orgId: 'org_1',
    projectId: 'loom',
    trigger: 'request',
    title: 'Make the gift note optional',
    proposal: "I'd make the gift-note field optional at checkout.",
    signals: overrides.signals ?? {},
    estimate: { lowCents: 400, highCents: 900 },
    capCents: overrides.capCents ?? 1500,
    checkpointAtFractions: overrides.checkpointAtFractions,
    now: T,
  });
}

/** Apply a sequence of actions, asserting each step succeeds; returns the final card. */
function run(start: Card, actions: CardAction[]): Card {
  let c = start;
  for (const a of actions) {
    const r = advance(c, a);
    if (!r.ok) throw new Error(`unexpected error ${r.error} on ${a.type}`);
    c = r.card;
  }
  return c;
}

describe('card machine — the happy path both triggers walk', () => {
  it('propose → approve → work → verify → done', () => {
    const done = run(card(), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
      { type: 'spend', at: T, cents: 300 },
      { type: 'begin_verify', at: T },
      { type: 'complete', at: T, verdict: 'verified' },
    ]);
    expect(done.state).toBe('done');
    expect(done.verdict).toBe('verified');
    expect(done.spentCents).toBe(300);
    expect(done.acts.map((a) => a.kind)).toContain('work_started');
  });
});

describe('card machine — the hard gate cannot be walked through', () => {
  it('a sensitive card cannot be approved without a verified backup', () => {
    const c = card({ signals: { touchesPayments: true } });
    expect(c.gate).toBe('hard');
    const blocked = advance(c, { type: 'approve', at: T });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toBe('backup_required');
  });

  it('with a verified backup, the sensitive card approves', () => {
    const c = card({ signals: { touchesAuth: true } });
    const r = advance(c, { type: 'approve', at: T, backupVerified: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.state).toBe('approved');
      expect(r.card.backupVerified).toBe(true);
    }
  });

  it('work can never start without an approval', () => {
    const r = advance(card(), { type: 'start_work', at: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('wrong_state');
  });
});

describe('card machine — the cap actually stops', () => {
  it('spending to the cap ends the card as stopped, never silently exceeding it', () => {
    const working = run(card({ capCents: 1000 }), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
    ]);
    const r = advance(working, { type: 'spend', at: T, cents: 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.card.state).toBe('stopped');
      expect(r.card.verdict).toBe('stopped');
      expect(r.card.acts.at(-1)!.kind).toBe('cap_reached');
    }
  });

  it('a spend past the cap cannot be followed by more spend', () => {
    const stopped = run(card({ capCents: 1000 }), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
      { type: 'spend', at: T, cents: 1200 },
    ]);
    const r = advance(stopped, { type: 'spend', at: T, cents: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('terminal');
  });

  it('a non-positive spend is rejected', () => {
    const working = run(card(), [{ type: 'approve', at: T }, { type: 'start_work', at: T }]);
    expect(advance(working, { type: 'spend', at: T, cents: 0 }).ok).toBe(false);
  });

  it("a spend with a note appends a 'worked' act — the work lands on the ledger's spine", () => {
    const working = run(card(), [{ type: 'approve', at: T }, { type: 'start_work', at: T }]);
    const r = advance(working, {
      type: 'spend',
      at: T,
      cents: 50,
      detail: 'Changed the checkout form. Pushed to branch selvedge/card_1 for your review.',
      meta: { tools: [{ id: 't1', name: 'Edit', detail: 'Editing src/Checkout.tsx' }] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const act = r.card.acts.at(-1)!;
    expect(act.kind).toBe('worked');
    expect(act.detail).toMatch(/checkout form/i);
    expect(act.meta).toMatchObject({ tools: [{ name: 'Edit' }] });
    expect(r.card.spentCents).toBe(50);
    expect(r.card.state).toBe('working'); // an ordinary spend never changes state
  });

  it('a detail-less spend appends no act — exactly the pre-recorder shape', () => {
    const working = run(card(), [{ type: 'approve', at: T }, { type: 'start_work', at: T }]);
    const before = working.acts.length;
    const r = advance(working, { type: 'spend', at: T, cents: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.card.acts.length).toBe(before);
  });
});

describe('card machine — staged checkpoints pause large work', () => {
  it('crossing a checkpoint fraction blocks for the owner, who can continue', () => {
    const working = run(card({ capCents: 10000, checkpointAtFractions: [0.4, 0.75] }), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
    ]);
    // Spend to 45% — crosses the 40% checkpoint.
    const atCheck = advance(working, { type: 'spend', at: T, cents: 4500 });
    expect(atCheck.ok).toBe(true);
    if (!atCheck.ok) return;
    expect(atCheck.card.state).toBe('blocked');
    expect(atCheck.card.acts.at(-1)!.kind).toBe('checkpoint');

    // Owner continues; work resumes and the next checkpoint still lies ahead.
    const resumed = advance(atCheck.card, { type: 'resume', at: T });
    expect(resumed.ok && resumed.card.state).toBe('working');
  });

  it('small work has no checkpoints and runs straight through', () => {
    const c = card({ capCents: 1500 });
    expect(c.stop.checkpointAtFractions).toEqual([]);
    const working = run(c, [{ type: 'approve', at: T }, { type: 'start_work', at: T }]);
    const r = advance(working, { type: 'spend', at: T, cents: 500 });
    expect(r.ok && r.card.state).toBe('working'); // no pause
  });

  it('an owner stop from a checkpoint pause ends the card', () => {
    const blocked = run(card({ capCents: 10000, checkpointAtFractions: [0.4] }), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
      { type: 'spend', at: T, cents: 4500 },
    ]);
    expect(blocked.state).toBe('blocked');
    const r = advance(blocked, { type: 'stop', at: T, reason: 'not worth it' });
    expect(r.ok && r.card.state).toBe('stopped');
    expect(r.ok && r.card.verdict).toBe('stopped');
  });
});

describe('card machine — terminal states are final', () => {
  it('a declined card rejects everything', () => {
    const declined = run(card(), [{ type: 'decline', at: T }]);
    expect(declined.state).toBe('declined');
    for (const a of [{ type: 'approve' as const, at: T }, { type: 'start_work' as const, at: T }]) {
      const r = advance(declined, a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('terminal');
    }
  });

  it('an honest non-success verdict still completes the loop', () => {
    const done = run(card(), [
      { type: 'approve', at: T },
      { type: 'start_work', at: T },
      { type: 'begin_verify', at: T },
      { type: 'complete', at: T, verdict: 'inconclusive' },
    ]);
    expect(done.state).toBe('done');
    expect(done.verdict).toBe('inconclusive'); // "I can't tell" is a real outcome, not hidden
  });
});
