import { describe, it, expect } from 'vitest';
import { route, loadRoutingTable, findRow, findRowById } from '../../src/server/routing/index.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('routing/index.ts public surface', () => {
  it('re-exports route, loadRoutingTable, findRow, findRowById', () => {
    expect(typeof route).toBe('function');
    expect(typeof loadRoutingTable).toBe('function');
    expect(typeof findRow).toBe('function');
    expect(typeof findRowById).toBe('function');

    const pack = makeTestPack({ stakes: { tier: 'sandbox', has_external_users: false, touches_money: false } });
    expect(route({ event_type: 'build.started' }, pack).path).toBe('SILENT');
  });
});
