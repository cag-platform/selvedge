import { describe, it, expect } from 'vitest';
import { cardEdge, stateLabel, needsOwner, inMotion, formatCents, formatRange, gateNote, type CardState } from '../../src/client/lib/card.js';

describe('cardEdge — read the state from the edge, never a false all-clear', () => {
  it('needs-you states wear the thread edge', () => {
    expect(cardEdge('proposed', null)).toBe('needs');
    expect(cardEdge('blocked', null)).toBe('needs');
  });

  it('in-motion states are brass', () => {
    for (const s of ['approved', 'working', 'verifying'] as const) expect(cardEdge(s, null)).toBe('working');
  });

  it('only a clean verdict is healthy', () => {
    expect(cardEdge('done', 'verified')).toBe('healthy');
    expect(cardEdge('done', 'probably')).toBe('unknown');
  });

  it('an unclear or halted ending is dashed unknown, never healthy', () => {
    expect(cardEdge('done', 'inconclusive')).toBe('unknown');
    expect(cardEdge('done', 'didnt_work')).toBe('unknown');
    expect(cardEdge('stopped', 'stopped')).toBe('unknown');
    expect(cardEdge('failed', null)).toBe('unknown');
    expect(cardEdge('declined', null)).toBe('unknown');
  });
});

describe('needsOwner — exactly the two states that ask for a decision', () => {
  it('is true for proposed and blocked, false otherwise', () => {
    expect(needsOwner('proposed')).toBe(true);
    expect(needsOwner('blocked')).toBe(true);
    for (const s of ['approved', 'working', 'verifying', 'done', 'declined', 'stopped', 'failed'] as const) {
      expect(needsOwner(s)).toBe(false);
    }
  });
});

describe('stateLabel — the verdict is spoken plainly, including "I can\'t tell"', () => {
  it('folds the verdict into the done label', () => {
    expect(stateLabel('done', 'verified')).toMatch(/verified/i);
    expect(stateLabel('done', 'inconclusive')).toMatch(/can't fully tell/i);
    expect(stateLabel('done', 'didnt_work')).toMatch(/didn't work/i);
  });
  it('names the paused and failed states in plain words', () => {
    expect(stateLabel('blocked', null)).toMatch(/needs you/i);
    expect(stateLabel('failed', null)).toMatch(/couldn't finish/i);
  });
});

describe('money formatting', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(600)).toBe('$6.00');
    expect(formatCents(0)).toBe('$0.00');
  });
  it('collapses a range when the ends match', () => {
    expect(formatRange(600, 2400)).toBe('$6.00–$24.00');
    expect(formatRange(500, 500)).toBe('$5.00');
  });
});

describe('gateNote — the hard gate explained in plain words', () => {
  it('a sensitive change explains why a backup is required', () => {
    expect(gateNote('sensitive')).toMatch(/backup/i);
    expect(gateNote('sensitive')).toMatch(/payments|logins|customer data/i);
  });
  it('ordinary has no note; cosmetic reads as low risk', () => {
    expect(gateNote('ordinary')).toBeNull();
    expect(gateNote('cosmetic')).toMatch(/low risk/i);
  });
});

/**
 * The split the workbench now depends on. Work that needs you is folded into
 * the thread; work in motion sits in Now; everything else is history. If a
 * state fell through all three, it would appear NOWHERE — which is exactly the
 * silent disappearance the product is built to prevent.
 */
describe('needsOwner / inMotion — the split that decides where work is shown', () => {
  const ALL: CardState[] = ['proposed', 'approved', 'working', 'blocked', 'verifying', 'done', 'declined', 'stopped', 'failed'];

  it('never claims a state is both waiting on you and running', () => {
    for (const s of ALL) expect(needsOwner(s) && inMotion(s)).toBe(false);
  });

  it('every open state is one or the other — nothing falls out of both', () => {
    for (const s of ['proposed', 'blocked', 'approved', 'working', 'verifying'] as const) {
      expect(needsOwner(s) || inMotion(s)).toBe(true);
    }
  });

  it('a closed card is neither — it belongs in history', () => {
    for (const s of ['done', 'declined', 'stopped', 'failed'] as const) {
      expect(needsOwner(s)).toBe(false);
      expect(inMotion(s)).toBe(false);
    }
  });
});
