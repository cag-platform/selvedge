import { describe, it, expect } from 'vitest';
import { narrate } from '../../src/server/narration/narrate.js';
import { route } from '../../src/server/routing/route.js';
import { loadRoutingTable } from '../../src/server/routing/table.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarratableEvent } from '../../src/server/narration/types.js';

function testEvent(eventType: string): NarratableEvent {
  return { id: 'evt_1', event_type: eventType, occurred_at: '2026-07-19T10:00:00Z', severity_hint: 'info' };
}

describe('narrate', () => {
  it('returns null for a SILENT decision', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'build.started' }, pack);
    expect(narrate(testEvent('build.started'), pack, decision)).toBeNull();
  });

  it('renders a TEMPLATE decision with fragment + technicalDetail at plain_expandable', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_expandable' },
    });
    const decision = route({ event_type: 'code.pr_opened' }, pack);
    const output = narrate(testEvent('code.pr_opened'), pack, decision);
    expect(output?.fragment).toContain(pack.identity.name);
    expect(output?.technicalDetail).toContain('code.pr_opened');
  });

  it('omits technicalDetail at plain_only', () => {
    const pack = makeTestPack({
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
      voice: { detail_level: 'plain_only' },
    });
    const decision = route({ event_type: 'code.pr_opened' }, pack);
    const output = narrate(testEvent('code.pr_opened'), pack, decision);
    expect(output?.technicalDetail).toBeUndefined();
    expect(output?.fragment).toBeTruthy();
  });

  it('B4 always carries verdict users_fine — a build that never deployed cannot change production', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack);
    const output = narrate(testEvent('build.failed'), pack, decision);
    expect(output?.verdict).toBe('users_fine');
  });

  it('B6 carries verdict users_fine (previous version still serving, by the row\'s own definition)', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'deploy.failed_previous_serving' }, pack);
    const output = narrate(testEvent('deploy.failed_previous_serving'), pack, decision);
    expect(output?.verdict).toBe('users_fine');
  });

  it('B7 carries verdict users_affected (nothing serving, by the row\'s own definition)', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'deploy.failed_nothing_serving' }, pack);
    const output = narrate(testEvent('deploy.failed_nothing_serving'), pack, decision);
    expect(output?.verdict).toBe('users_affected');
  });

  it('has a registered template for every v1_scope Group A/B/E row the router can produce a non-SILENT decision for', () => {
    const table = loadRoutingTable();
    const tiers = table.tiers as Array<'sandbox' | 'personal' | 'live_small' | 'live_critical'>;
    const coveredGroups = new Set(['A', 'B', 'C', 'E']); // E1/E4 are org-level (tested separately); E2 goes through narrate()

    for (const row of table.rows) {
      if (!row.v1_scope || row.event_type === null || !coveredGroups.has(row.group)) continue;
      if (row.id === 'E1' || row.id === 'E4') continue;

      for (const tier of tiers) {
        const tierDecision = row.tiers[tier];
        if (!tierDecision || tierDecision.path === 'SILENT') continue;

        const pack = makeTestPack({ stakes: { tier, has_external_users: true, touches_money: false } });
        const decision = route({ event_type: row.event_type }, pack);
        expect(() => narrate(testEvent(row.event_type!), pack, decision)).not.toThrow();
      }
    }
  });

  /**
   * TWO SENTENCES THAT REACHED A REAL SCREEN.
   *
   *   "AI Chess looks down right now — users are affected: the people who use
   *    it are affected."
   *   "AI Chess: your update couldn't go live. The previous version is still
   *    running — users are fine, and the people who use it are affected is not
   *    happening."
   *
   * `downtime_translation` is a NOUN PHRASE the owner writes — "orders stop
   * going through". Its fallback was a full sentence wearing a noun phrase's
   * clothes, so the first output says one thing twice (the generic restates
   * the verdict phrase it was appended to) and the second is not grammatical.
   *
   * An owner who never wrote down what downtime costs them has told us nothing
   * about it, and every generic either repeats the verdict or invents a
   * consequence. So the clause is dropped and the sentence is shorter.
   */
  describe("what downtime costs, when the owner never said", () => {
    const noTranslation = () => makeTestPack({ stakes: { tier: 'live_small', has_external_users: true, touches_money: false } });
    const withTranslation = () =>
      makeTestPack({
        stakes: { tier: 'live_small', has_external_users: true, touches_money: false, downtime_translation: 'orders stop going through' },
      });

    const say = (eventType: string, pack: ReturnType<typeof makeTestPack>) =>
      narrate(testEvent(eventType), pack, route({ event_type: eventType }, pack))?.fragment ?? '';

    it('never says the same thing twice when nothing was written down', () => {
      const line = say('runtime.health_failing', noTranslation());
      expect(line).toContain('users are affected');
      expect(line).not.toContain('the people who use it are affected');
      // One statement of who is affected, not two.
      expect(line.match(/affected/g) ?? []).toHaveLength(1);
      expect(line).toMatch(/\.$/);
    });

    it('never produces the ungrammatical clause', () => {
      const line = say('deploy.failed_previous_serving', noTranslation());
      expect(line).not.toContain('is not happening');
      expect(line).toContain('users are fine');
      expect(line).toMatch(/users are fine\.$/);
    });

    it('and drops the clause on the nothing-serving row too', () => {
      const line = say('deploy.failed_nothing_serving', noTranslation());
      expect(line).toMatch(/users are affected\.$/);
    });

    /** The whole point of the slot: when the owner DID write it, it is used. */
    it('uses the owner\'s own words wherever they gave them', () => {
      expect(say('runtime.health_failing', withTranslation())).toContain('orders stop going through');
      expect(say('deploy.failed_nothing_serving', withTranslation())).toContain('orders stop going through');
      expect(say('deploy.failed_previous_serving', withTranslation())).toContain('orders stop going through is not happening');
    });

    it('treats a whitespace-only translation as never written', () => {
      const blank = makeTestPack({
        stakes: { tier: 'live_small', has_external_users: true, touches_money: false, downtime_translation: '   ' },
      });
      expect(say('runtime.health_failing', blank)).toMatch(/users are affected\.$/);
    });
  });
});
