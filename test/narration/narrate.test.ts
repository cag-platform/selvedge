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

  it('B4 always carries verdict users_not_affected — a build that never deployed cannot change production', () => {
    const pack = makeTestPack({ stakes: { tier: 'live_critical', has_external_users: true, touches_money: false } });
    const decision = route({ event_type: 'build.failed' }, pack);
    const output = narrate(testEvent('build.failed'), pack, decision);
    expect(output?.verdict).toBe('users_not_affected');
  });

  it('B6 carries verdict users_not_affected (previous version still serving, by the row\'s own definition)', () => {
    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    const decision = route({ event_type: 'deploy.failed_previous_serving' }, pack);
    const output = narrate(testEvent('deploy.failed_previous_serving'), pack, decision);
    expect(output?.verdict).toBe('users_not_affected');
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
});
