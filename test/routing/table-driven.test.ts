import { describe, it, expect } from 'vitest';
import { route } from '../../src/server/routing/route.js';
import { loadRoutingTable } from '../../src/server/routing/table.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { StakesTier } from '../../src/shared/types/pack.js';

const table = loadRoutingTable();

function expectedPath(intended: string): 'SILENT' | 'TEMPLATE' {
  return intended === 'SILENT' ? 'SILENT' : 'TEMPLATE';
}

describe('routing table — one fixture per row × tier', () => {
  for (const row of table.rows) {
    if (row.event_type === null) continue; // standing (G) / cross-project (F) / modifier (B8) rows: not per-event routable

    for (const tier of table.tiers as StakesTier[]) {
      const tierDecision = row.tiers[tier];

      if (tierDecision === null || tierDecision === undefined) {
        it(`${row.id} @ ${tier}: no decision defined -> route() throws`, () => {
          const pack = makeTestPack({ stakes: { tier, has_external_users: true, touches_money: false } });
          expect(() => route({ event_type: row.event_type! }, pack)).toThrow(/no decision for tier/i);
        });
        continue;
      }

      it(`${row.id} @ ${tier}: ${row.label}`, () => {
        const pack = makeTestPack({ stakes: { tier, has_external_users: true, touches_money: false } });
        const decision = route({ event_type: row.event_type! }, pack);

        expect(decision.row_id).toBe(row.id);
        expect(decision.intended_path).toBe(tierDecision.path);
        expect(decision.path).toBe(expectedPath(tierDecision.path));

        // At baseline (no pack.voice.notify.push_threshold set) the router
        // defaults to 'failures': C2/D1/D2 aren't failure-class rows, so
        // they're capped to DIGEST even though the table says PUSH; C2
        // additionally requires its paired outage to have pushed.
        const cappedByDefaultThreshold = new Set(['C2', 'D1', 'D2']);
        const expectedDelivery =
          cappedByDefaultThreshold.has(row.id) && tierDecision.delivery === 'PUSH' ? 'DIGEST' : tierDecision.delivery;
        expect(decision.delivery).toBe(expectedDelivery);
      });
    }
  }

  it('throws for an unknown event_type', () => {
    const pack = makeTestPack();
    expect(() => route({ event_type: 'nonsense.event' }, pack)).toThrow(/No routing-table.json row/);
  });

  it('loadRoutingTable caches the parsed file across calls', () => {
    expect(loadRoutingTable()).toBe(loadRoutingTable());
  });
});
