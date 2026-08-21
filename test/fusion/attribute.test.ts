import { describe, it, expect } from 'vitest';
import { composeFusion, dayPhrase, type SessionAttribution } from '../../src/server/fusion/attribute.js';

const BREAK = new Date('2026-08-20T14:00:00Z'); // a Thursday

const observed = (over: Partial<Extract<SessionAttribution, { kind: 'observed' }>> = {}): SessionAttribution => ({
  kind: 'observed',
  sessionId: 'cx-1',
  agent: 'codex',
  intent: 'the guest-checkout work',
  at: '2026-08-17T11:00:00Z', // Monday
  commit: 'a1b2c3d',
  ...over,
});

const inSelvedge = (over: Partial<Extract<SessionAttribution, { kind: 'selvedge' }>> = {}): SessionAttribution => ({
  kind: 'selvedge',
  threadId: 't1',
  title: 'Checkout rework',
  agent: 'claude-code',
  at: '2026-08-19T09:00:00Z', // Wednesday, i.e. yesterday
  commit: 'b2c3d4e',
  ...over,
});

const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };
const fuse = (attributions: SessionAttribution[]) => composeFusion(attributions, BREAK, (id) => names[id] ?? id);

/**
 * The sentence the whole product was built to be able to say — and the rules
 * that keep it honest, which matter more than the sentence does. A wrong
 * attribution is someone spending their morning reading the wrong diff because
 * a machine sounded certain.
 */
describe('fusion — from a break to the work behind it', () => {
  it('says the sentence, naming the session and what it was for', () => {
    const fused = fuse([observed()])!;
    expect(fused.sentence).toBe("This began after the change from Monday's Codex session (the guest-checkout work).");
    expect(fused.ambiguous).toBe(false);
  });

  it('names work done here by the thread the owner named', () => {
    expect(fuse([inSelvedge()])!.sentence).toBe('This began after the change from yesterday\'s work in "Checkout rework" here.');
  });

  it('NEVER says caused — "began after" is exactly what the evidence supports', () => {
    for (const attributions of [[observed()], [inSelvedge()], [observed(), inSelvedge()]]) {
      const fused = fuse(attributions)!;
      expect(fused.sentence).toMatch(/began after/);
      expect(fused.sentence).not.toMatch(/caused|because of|due to|responsible/i);
    }
  });

  it('refuses to pick when more than one session could be behind it', () => {
    // The whole test of the feature: two plausible culprits produce a sentence
    // that names both and picks neither. "I can't tell which" is a correct and
    // shippable output; a coin toss dressed as an answer is not.
    const fused = fuse([observed(), inSelvedge()])!;
    expect(fused.ambiguous).toBe(true);
    expect(fused.sentence).toMatch(/I can't tell which/);
    expect(fused.sentence).toContain('Codex session');
    expect(fused.sentence).toContain('Checkout rework');
  });

  it('names three and counts the rest, rather than listing everything', () => {
    const many = [observed({ sessionId: 'a' }), observed({ sessionId: 'b' }), observed({ sessionId: 'c' }), observed({ sessionId: 'd' })];
    const fused = fuse(many)!;
    expect(fused.sentence).toMatch(/and 1 more/);
    expect(fused.sentence).toMatch(/I can't tell which/);
  });

  it('says nothing at all when no session can be named', () => {
    // The common case, and the one that keeps the feature honest: correlation's
    // own "started right after new code landed" stands alone, and no session is
    // reached for.
    expect(fuse([])).toBeNull();
  });

  it('uses the distance when the work happened on the same day as the break', () => {
    // "Monday's" says nothing when the break was Monday too; the gap is the
    // useful fact.
    const sameDay = fuse([observed({ at: '2026-08-20T11:00:00Z' })])!;
    expect(sameDay.sentence).toBe('This began after the change from the Codex session (the guest-checkout work), 3 hours earlier.');
    const minutesAgo = fuse([observed({ at: '2026-08-20T13:20:00Z' })])!;
    expect(minutesAgo.sentence).toContain('40 minutes earlier');
  });

  it('says when things happened the way a person would', () => {
    const now = new Date('2026-08-20T14:00:00Z'); // Thursday
    expect(dayPhrase(new Date('2026-08-20T09:00:00Z'), now)).toBe('earlier today');
    expect(dayPhrase(new Date('2026-08-19T09:00:00Z'), now)).toBe("yesterday's");
    expect(dayPhrase(new Date('2026-08-17T09:00:00Z'), now)).toBe("Monday's");
    expect(dayPhrase(new Date('2026-08-03T09:00:00Z'), now)).toBe('the 3 August');
  });

  it('drops an intent it was never given, rather than inventing a description', () => {
    expect(fuse([observed({ intent: null })])!.sentence).toBe("This began after the change from Monday's Codex session.");
  });
});
