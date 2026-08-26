import { describe, it, expect } from 'vitest';
import {
  OBSERVED_NOTE,
  askEntry,
  cardStatus,
  eventEntry,
  orderTimeline,
  runEntry,
  sessionEntry,
  switchEntry,
  threadEntry,
  verdictEntry,
  type CardRow,
} from '../../src/server/timeline/entries.js';

const card = (over: Partial<CardRow> = {}): CardRow => ({
  id: 'c1',
  title: 'a dark header',
  proposal: 'Make the site header dark, matching the rest of the shop.',
  trigger: 'request',
  risk: 'ordinary',
  gate: 'normal',
  state: 'proposed',
  verdict: null,
  gradedBy: null,
  spentCents: 0,
  createdAt: new Date('2026-08-01T09:00:00Z'),
  updatedAt: new Date('2026-08-01T09:00:00Z'),
  ...over,
});

/**
 * The timeline is a projection, so its whole trustworthiness is here: one
 * plain sentence per thing that actually happened, an edge that means what it
 * means everywhere else in the product, and no sentence at all for something
 * the record doesn't contain.
 */
describe('the timeline vocabulary', () => {
  it('says what was asked, in the owner\'s own words', () => {
    const entry = askEntry(card());
    expect(entry.sentence).toBe('You asked for: a dark header');
    expect(entry.kind).toBe('ask');
    expect(entry.evidence[0]).toContain('matching the rest of the shop');
    expect(entry.ref.card_id).toBe('c1');
  });

  it('distinguishes an ask from something that broke and was proposed', () => {
    expect(askEntry(card({ trigger: 'incident' })).sentence).toMatch(/^Something broke, so I proposed/);
  });

  it('carries the hard gate into the evidence, because that is why it waited', () => {
    expect(askEntry(card({ risk: 'sensitive', gate: 'hard' })).evidence.join(' ')).toMatch(/confirmed backup/);
  });

  it('reads a finished verdict the way the product says it everywhere else', () => {
    const verified = verdictEntry(card({ state: 'done', verdict: 'verified', gradedBy: 'independent', spentCents: 240 }))!;
    expect(verified.sentence).toMatch(/a different model than wrote it checked/);
    expect(verified.status).toBe('healthy');
    expect(verified.evidence).toContain('Cost $2.40.');
    expect(verified.evidence.join(' ')).toMatch(/Checked by a different model/);

    const probably = verdictEntry(card({ state: 'done', verdict: 'probably', gradedBy: 'ungraded' }))!;
    expect(probably.sentence).toMatch(/nothing independent checked it/);
    expect(probably.evidence.join(' ')).toMatch(/tops out at "probably"/);
  });

  it("never lets 'I couldn't tell' read as fine", () => {
    const unsure = verdictEntry(card({ state: 'done', verdict: 'inconclusive' }))!;
    expect(unsure.status).toBe('unknown'); // dashed, shape-distinct — never healthy
    expect(unsure.sentence).toMatch(/couldn't tell/);
    expect(verdictEntry(card({ state: 'done', verdict: 'didnt_work' }))!.status).toBe('unknown');
    expect(cardStatus('done', 'didnt_work')).toBe('unknown');
    expect(cardStatus('done', 'verified')).toBe('healthy');
    expect(cardStatus('proposed', null)).toBe('needs');
    expect(cardStatus('working', null)).toBe('working');
    expect(cardStatus('failed', null)).toBe('needs');
  });

  it('has no verdict line for work that has not finished', () => {
    expect(verdictEntry(card({ state: 'working' }))).toBeNull();
    expect(verdictEntry(card({ state: 'proposed' }))).toBeNull();
  });

  it('records a decline as a decision, not as a failure', () => {
    const declined = verdictEntry(card({ state: 'declined' }))!;
    expect(declined.sentence).toMatch(/^You turned down/);
    expect(declined.evidence.join(' ')).toMatch(/nothing was spent/i);
  });

  it('tells a ship from an undo, and says what actually changed', () => {
    const ship = runEntry({
      id: 'r1',
      threadId: 't1',
      prompt: 'ship: guest checkout',
      status: 'succeeded',
      agent: 'claude-code',
      commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      costCents: null,
      changedPaths: ['src/checkout/Cart.tsx', 'src/lib/validation.ts', 'src/app.tsx', 'src/x.ts'],
      createdAt: new Date('2026-08-02T10:00:00Z'),
    })!;
    expect(ship.kind).toBe('ship');
    expect(ship.sentence).toBe('Shipped: guest checkout');
    expect(ship.evidence[0]).toBe('4 files changed, including src/checkout/Cart.tsx, src/lib/validation.ts, src/app.tsx.');
    expect(ship.evidence[1]).toBe('Commit a1b2c3d.');

    const undo = runEntry({
      id: 'r2',
      threadId: 't1',
      prompt: 'undo: revert of a1b2c3d',
      status: 'succeeded',
      agent: null,
      commitSha: 'a1b2c3d',
      costCents: null,
      changedPaths: null,
      createdAt: new Date('2026-08-02T11:00:00Z'),
    })!;
    expect(undo.kind).toBe('undo');
    expect(undo.sentence).toMatch(/undone/);
  });

  it('puts completed run evidence in history without treating probably as healthy', () => {
    const entry = runEntry({ id: 'run_1', threadId: 'thread_1', prompt: 'Fix sign in', status: 'succeeded', agent: 'codex', commitSha: null, costCents: 2, changedPaths: ['src/auth.ts'], createdAt: new Date(), evidence: { summary: 'Probably working', explanation: 'No acceptance observation confirmed it.', status: 'unknown' } });
    expect(entry).toMatchObject({ kind: 'evidence', status: 'unknown', ref: { run_id: 'run_1', thread_id: 'thread_1' } });
    expect(entry?.sentence).toContain('Probably working');
  });

  it('leaves ordinary turns out — a conversation is not history', () => {
    expect(
      runEntry({
        id: 'r3',
        threadId: 't1',
        prompt: 'make the header dark',
        status: 'succeeded',
        agent: 'claude-code',
        commitSha: null,
        costCents: 18,
        changedPaths: ['src/App.tsx'],
        createdAt: new Date(),
      }),
    ).toBeNull();
  });

  it('says who took the work over, and keeps the handover line verbatim', () => {
    const entry = switchEntry(
      {
        id: 's1',
        threadId: 't1',
        content: '⇄ continued with Codex — handoff 1.8k tokens, about $0.004',
        createdAt: new Date('2026-08-03T09:00:00Z'),
        meta: { switch: { from: 'claude-code', to: 'codex', tokens: 1834, cost_usd: 0.0037 } },
      },
      (a) => (a === 'codex' ? 'Codex' : 'Claude Code'),
    );
    expect(entry.sentence).toBe('The work passed from Claude Code to Codex mid-thread, carrying what had happened so far.');
    // The evidence is the thread's own line, with its real numbers — the
    // timeline must not soften what the switch actually cost.
    expect(entry.evidence[0]).toContain('1.8k tokens, about $0.004');
  });

  it('shows what the watching said, in the words the brief used', () => {
    const entry = eventEntry({
      id: 'n1',
      eventId: 'e1',
      eventType: 'runtime.error_spike',
      occurredAt: new Date('2026-08-04T02:00:00Z'),
      fragment: 'Checkout started failing just after last night\'s change.',
      technicalDetail: 'error rate 14% over 10 minutes',
      verdict: 'users_affected',
      confidence: 'high',
      kind: 'attention',
    })!;
    expect(entry.sentence).toBe("Checkout started failing just after last night's change.");
    expect(entry.status).toBe('needs'); // the one place red is allowed
    expect(entry.evidence).toContain('error rate 14% over 10 minutes');
  });

  it('says nothing at all for a narration that said nothing', () => {
    // A silent narration is a deliberate non-event. Inventing a line for it
    // would be the timeline claiming to have seen something it didn't.
    expect(
      eventEntry({
        id: 'n2',
        eventId: 'e2',
        eventType: 'code.push',
        occurredAt: new Date(),
        fragment: null,
        technicalDetail: null,
        verdict: null,
        confidence: null,
        kind: null,
      }),
    ).toBeNull();
  });

  it('names a workshop thread as work and a general thread as talk', () => {
    const build = threadEntry({ id: 't1', title: 'Checkout rework', kind: 'workshop', agent: 'claude-code', createdAt: new Date() });
    const talk = threadEntry({ id: 't2', title: 'Pricing', kind: 'general', agent: 'claude', createdAt: new Date() });
    expect(build.sentence).toMatch(/^A piece of work started/);
    expect(talk.sentence).toMatch(/^A conversation started/);
    expect(talk.evidence[0]).toMatch(/nothing is built/i);
  });

  it('marks a session Selvedge did not run as observed, every time', () => {
    const entry = sessionEntry(
      {
        id: 'x1',
        agent: 'codex',
        sessionId: 'cx-1',
        intent: 'make the checkout one page',
        filesTouched: ['src/Cart.tsx', 'src/lib/validation.ts'],
        toolsRun: { shell: 4, apply_patch: 2 },
        outcome: 'shipped',
        commitSha: 'a1b2c3d4e5f6',
        costUsd: 0.42,
        detail: null,
        startedAt: new Date('2026-08-20T09:00:00Z'),
        endedAt: new Date('2026-08-20T10:00:00Z'),
        createdAt: new Date('2026-08-20T10:05:00Z'),
      },
      () => 'Codex',
    );
    expect(entry.sentence).toBe('A Codex session ran here outside Selvedge — "make the checkout one page", and a commit landed (a1b2c3d).');
    // Motion, never health: this work was not gated or checked here, and the
    // mark that says so rides on every one of these.
    expect(entry.status).toBe('working');
    expect(entry.evidence).toContain(OBSERVED_NOTE);
    expect(entry.evidence.join(' ')).toContain('src/Cart.tsx');
    expect(entry.evidence.join(' ')).toContain('shell ×4');
    expect(entry.sentence).not.toMatch(/verified|checked|held up/i);
  });

  it('says out loud when it could not read a session at all', () => {
    const entry = sessionEntry(
      {
        id: 'x2',
        agent: 'codex',
        sessionId: 'cx-2',
        intent: null,
        filesTouched: null,
        toolsRun: null,
        outcome: 'unreadable',
        commitSha: null,
        costUsd: null,
        detail: 'the log never said which session it was',
        startedAt: null,
        endedAt: null,
        createdAt: new Date('2026-08-20T10:05:00Z'),
      },
      () => 'Codex',
    );
    expect(entry.sentence).toMatch(/couldn't read a Codex session/);
    expect(entry.status).toBe('unknown'); // dashed: I can't see this
    expect(entry.evidence[0]).toBe('the log never said which session it was');
  });

  it('orders newest first, and never reshuffles two things from the same moment', () => {
    const at = new Date('2026-08-05T12:00:00Z');
    const a = threadEntry({ id: 'a', title: 'A', kind: 'general', agent: 'claude', createdAt: at });
    const b = threadEntry({ id: 'b', title: 'B', kind: 'general', agent: 'claude', createdAt: at });
    const older = threadEntry({ id: 'c', title: 'C', kind: 'general', agent: 'claude', createdAt: new Date('2026-08-01T12:00:00Z') });
    expect(orderTimeline([older, b, a]).map((e) => e.id)).toEqual(['thread:a', 'thread:b', 'thread:c']);
    expect(orderTimeline([a, b, older]).map((e) => e.id)).toEqual(['thread:a', 'thread:b', 'thread:c']);
  });
});
