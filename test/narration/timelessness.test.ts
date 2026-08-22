import { describe, it, expect } from 'vitest';
import { templateRegistry } from '../../src/server/narration/templates/registry.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarratableEvent } from '../../src/server/narration/types.js';

/**
 * A NARRATION IS WRITTEN ONCE AND READ FOREVER.
 *
 * Every fragment is composed at ingest and stored on the narration row. It is
 * then rendered by whatever surface asks for it, days or weeks later — a
 * project's timeline, the status strip, an export.
 *
 * So a fragment may not contain a relative day. "new work landed on the main
 * branch today" was true when the only surface was a daily brief covering the
 * last 24 hours. The brief is retired, and that exact sentence sat in a
 * timeline directly beneath the date it actually happened — an entry stamped
 * "Aug 14" asserting "today". The product being wrong out loud, on screen,
 * about the one kind of thing it exists to get right.
 *
 * Every surface prints the real timestamp beside the fragment, so the word was
 * redundant where it was true and false everywhere else.
 *
 * This guards the CLASS, not the three instances that had it.
 */
describe('a narration fragment never claims when it happened', () => {
  // Words that pin a sentence to the day it was written. "right now" and "this
  // week" are deliberately not here: they describe a live incident state at the
  // moment of narration, which is a different (and arguable) call — see C1/C5.
  const RELATIVE_DAYS = /\b(today|yesterday|tomorrow|tonight|this morning|this afternoon|last night)\b/i;

  const pack = makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
  });

  const event: NarratableEvent = {
    id: 'evt_1',
    org_id: 'org_1',
    event_type: 'code.commits_landed_default',
    occurred_at: '2026-07-19T10:00:00Z',
    severity_hint: 'info',
  };

  it('holds for every template in the registry', () => {
    const offenders: string[] = [];
    for (const [id, template] of Object.entries(templateRegistry)) {
      const { fragment } = template(event, pack);
      const hit = RELATIVE_DAYS.exec(fragment);
      if (hit) offenders.push(`${id}: "${fragment}" — says "${hit[0]}"`);
    }
    expect(offenders).toEqual([]);
  });

  /** The regex has to actually catch the sentence that started this. */
  it('would have caught the one that shipped', () => {
    expect(RELATIVE_DAYS.test('Loom: new work landed on the main branch today.')).toBe(true);
    expect(RELATIVE_DAYS.test('Loom: new work landed on the main branch.')).toBe(false);
  });

  /** And must not fire on a word that merely contains one. */
  it('does not trip over a word that happens to contain one', () => {
    expect(RELATIVE_DAYS.test('the build is running on todays-branch')).toBe(false);
    expect(RELATIVE_DAYS.test('Loom: a branch has been quiet for two weeks — still want it?')).toBe(false);
  });
});
