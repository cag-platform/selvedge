import { describe, it, expect } from 'vitest';
import { composeProtectionBrief, coverageFromPack, type Coverage } from '../../src/server/brief/protection.js';
import { makeTestPack } from '../fixtures/testPack.js';

const pack = makeTestPack({
  identity: { project_id: 'loom', name: 'Loom', owner_description: 'a store that sells cloth' },
  stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
  topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
});

const full: Coverage = { code: true, runtime: true, data: true };
const none: Coverage = { code: false, runtime: false, data: false };

describe('composeProtectionBrief — never claim coverage you do not have', () => {
  it('fully connected: high confidence, no blind spots, no next step', () => {
    const b = composeProtectionBrief(pack, full);
    expect(b.confidence).toBe('high');
    expect(b.blindSpots).toEqual([]);
    expect(b.nextStep).toBeNull();
    expect(b.headline).toMatch(/watching all of Loom/i);
  });

  it('nothing connected: low confidence, and a first step that is the most valuable one', () => {
    const b = composeProtectionBrief(pack, none);
    expect(b.confidence).toBe('low');
    // Data is the highest-priority gap — silent loss is the worst pain.
    expect(b.nextStep).toMatch(/data/i);
    expect(b.blindSpots.length).toBe(3);
  });

  it('partial: names exactly the blind spots that are real', () => {
    const b = composeProtectionBrief(pack, { code: true, runtime: false, data: false });
    expect(b.confidence).toBe('partial');
    // Code is covered → its line is the "on" line, not a blind spot.
    const codeArea = b.coverage.find((c) => c.area === 'code')!;
    expect(codeArea.connected).toBe(true);
    expect(codeArea.line).toMatch(/see every change/i);
    // Runtime and data are the blind spots.
    expect(b.blindSpots.some((s) => /goes down/i.test(s))).toBe(true);
    expect(b.blindSpots.some((s) => /records stop saving|missing/i.test(s))).toBe(true);
  });

  it('always surfaces the data blind spot when data is disconnected — the pain that hurts most', () => {
    const b = composeProtectionBrief(pack, { code: true, runtime: true, data: false });
    expect(b.nextStep).toMatch(/data/i);
    expect(b.blindSpots.some((s) => /hurts most/i.test(s))).toBe(true);
  });

  it('speaks plainly — no infrastructure nouns in the customer-facing text', () => {
    const b = composeProtectionBrief(pack, none);
    const allText = [b.headline, b.whatItIs, b.nextStep, ...b.blindSpots, ...b.coverage.map((c) => c.line)].join(' ');
    for (const jargon of ['repository', 'Supabase', 'Railway', 'Postgres', 'DNS', 'webhook', 'env var']) {
      expect(allText.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });

  it('states the stakes plainly from the pack', () => {
    const b = composeProtectionBrief(pack, full);
    expect(b.whatItIs).toContain('Loom');
    expect(b.whatItIs).toMatch(/takes payments and has real users/i);
  });

  it('a low-stakes app reads without the "mistakes matter" clause', () => {
    const sandbox = makeTestPack({
      identity: { project_id: 'x', name: 'Sketch', owner_description: 'a weekend experiment' },
      stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
    });
    const b = composeProtectionBrief(sandbox, full);
    expect(b.whatItIs).not.toMatch(/mistakes here matter/i);
  });
});

describe('coverageFromPack — a listed source is not the same as a live connection', () => {
  it('code is covered when the pack has a github source', () => {
    const cov = coverageFromPack(pack, { host: false, database: false });
    expect(cov.code).toBe(true);
  });

  it('runtime and data follow the LIVE token, not the pack listing', () => {
    // Even if the pack listed a host/db source, coverage must reflect whether
    // a token actually resolved — claiming otherwise is false coverage.
    const cov = coverageFromPack(pack, { host: true, database: false });
    expect(cov.runtime).toBe(true);
    expect(cov.data).toBe(false);
  });
});
