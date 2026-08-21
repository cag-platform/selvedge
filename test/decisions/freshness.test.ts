import { describe, it, expect } from 'vitest';
import { freshnessOf, staleWarningFor } from '../../src/server/decisions/freshness.js';

const at = (iso: string) => ({ at: new Date(iso), role: 'owner' });

/**
 * The safety mechanism of the whole paired-thread feature, on its own.
 *
 * The failure it exists to prevent was named in the brief that specified the
 * feature: a stale brief producing a confidently wrong verdict. Someone changes
 * their mind at 4pm, the decision doesn't change with them, the builder works
 * from it, and something later reports that the work did what was decided.
 */
describe('how current a decision is', () => {
  const brief = (through: string | null, messages = 4) => ({ evidenceThrough: through ? new Date(through) : null, evidenceMessages: messages });

  it('is current when the conversation has not moved since', () => {
    const freshness = freshnessOf(brief('2026-08-20T12:00:00Z'), [at('2026-08-20T11:00:00Z'), at('2026-08-20T12:00:00Z')]);
    expect(freshness.state).toBe('current');
    expect(freshness.behind).toBe(0);
  });

  it('is stale the moment ANYTHING is said after it, and counts how much', () => {
    // Deliberately blunt: judging which messages changed the decision is
    // exactly the judgement that gets this wrong. The cost of bluntness is a
    // re-extraction nobody needed; the cost of cleverness is a wrong verdict.
    const one = freshnessOf(brief('2026-08-20T12:00:00Z'), [at('2026-08-20T12:00:00Z'), at('2026-08-20T13:00:00Z')]);
    expect(one).toMatchObject({ state: 'stale', behind: 1 });
    expect(one.note).toMatch(/One thing has been said/);

    const three = freshnessOf(brief('2026-08-20T12:00:00Z'), [
      at('2026-08-20T13:00:00Z'),
      at('2026-08-20T14:00:00Z'),
      at('2026-08-20T15:00:00Z'),
    ]);
    expect(three).toMatchObject({ state: 'stale', behind: 3 });
    expect(three.note).toMatch(/3 things have been said/);
    expect(three.note).toMatch(/may no longer be what you decided/);
  });

  it('a brief with no evidence recorded is behind everything', () => {
    // With nothing recorded there is no basis for calling it current, and
    // "unknown" must never resolve to "fine" in this product.
    expect(freshnessOf(brief(null, 0), [at('2026-01-01T00:00:00Z')]).state).toBe('stale');
  });

  it('warns the builder in words it can act on', () => {
    const warning = staleWarningFor({ state: 'stale', behind: 2, note: '' });
    expect(warning).toContain('before the last 2 messages');
    expect(warning).toMatch(/draft, not a settled decision/);
    expect(warning).toMatch(/say so rather than following it/);
  });
});
