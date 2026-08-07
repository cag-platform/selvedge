import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import { costUsd, providerForModel } from '../../src/server/llm/pricing.js';
import { recordUsage } from '../../src/server/llm/metering.js';
import { FakeLlmClient, DownLlmClient } from '../../src/server/llm/fake.js';

describe('llm/pricing', () => {
  it('computes cost from the config table', () => {
    // claude-sonnet-5: $3/MTok in, $15/MTok out
    expect(costUsd('claude-sonnet-5', 1_000_000, 0)).toBeCloseTo(3.0);
    expect(costUsd('claude-sonnet-5', 0, 1_000_000)).toBeCloseTo(15.0);
    expect(costUsd('claude-sonnet-5', 2000, 400)).toBeCloseTo((2000 * 3 + 400 * 15) / 1_000_000);
  });

  it('prices unknown models at the fallback (most expensive) rate — never undercounts', () => {
    expect(costUsd('claude-nonexistent-9', 1_000_000, 0)).toBeCloseTo(10.0);
  });
});

describe('llm/metering', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('records a successful call with computed cost', async () => {
    await recordUsage(
      db,
      'org_1',
      'fragment',
      { ok: true, json: {}, tokensIn: 1000, tokensOut: 200, model: 'claude-sonnet-5' },
      'evt_1',
    );
    const rows = await db.select().from(llmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('fragment');
    expect(rows[0]?.ok).toBe('true');
    expect(rows[0]?.eventId).toBe('evt_1');
    expect(rows[0]?.costUsd).toBeCloseTo((1000 * 3 + 200 * 15) / 1_000_000);
  });

  it('records a failed call with its reason — misses are visible in the same table', async () => {
    await recordUsage(db, 'org_1', 'compose', {
      ok: false,
      reason: 'refusal',
      tokensIn: 500,
      tokensOut: 0,
      model: 'claude-fable-5',
    });
    const rows = await db.select().from(llmUsage);
    expect(rows[0]?.ok).toBe('refusal');
    expect(rows[0]?.costUsd).toBeCloseTo((500 * 10) / 1_000_000);
  });

  /**
   * Model ids are not namespaced by provider, so without attribution a second
   * provider's spend is indistinguishable from the incumbent's in the ledger.
   */
  it('takes the provider from the client when it says so', async () => {
    await recordUsage(db, 'org_1', 'fragment', {
      ok: true, json: {}, tokensIn: 1, tokensOut: 1, model: 'some-model', provider: 'openai',
    });
    expect((await db.select().from(llmUsage))[0]?.provider).toBe('openai');
  });

  it('falls back to the pricing table when the client is silent', async () => {
    await recordUsage(db, 'org_1', 'fragment', { ok: true, json: {}, tokensIn: 1, tokensOut: 1, model: 'claude-sonnet-5' });
    expect((await db.select().from(llmUsage))[0]?.provider).toBe('anthropic');
  });

  it('records an unpriced model as unknown rather than filing it under the incumbent', async () => {
    // A misattributed row is a silent error; an unattributed one is a visible
    // gap. Prefer the gap.
    await recordUsage(db, 'org_1', 'fragment', { ok: true, json: {}, tokensIn: 1, tokensOut: 1, model: 'not-in-the-table' });
    expect((await db.select().from(llmUsage))[0]?.provider).toBe('unknown');
  });
});

describe('pricing — an unknown model must never look cheap', () => {
  it('prices an unpriced model at the fallback, which is the most expensive row', () => {
    const known = costUsd('claude-sonnet-5', 1_000_000, 0);
    const unknown = costUsd('a-model-nobody-priced', 1_000_000, 0);
    expect(unknown).toBeGreaterThan(known);
    // Overstating a new provider's spend is the safe direction to be wrong in:
    // it shows up as a cost surprise rather than as margin quietly leaking.
    expect(unknown).toBeCloseTo(10);
  });

  it('attributes each priced model to its provider', () => {
    expect(providerForModel('claude-opus-5')).toBe('anthropic');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('nothing-priced-this')).toBe('unknown');
  });
});

describe('llm/fake clients', () => {
  it('FakeLlmClient records requests and responds deterministically', async () => {
    const fake = new FakeLlmClient((req) => ({ ok: true, json: { echo: req.userContent }, tokensIn: 1, tokensOut: 1, model: req.model }));
    const result = await fake.complete({ model: 'm', system: 's', userContent: 'hello', maxTokens: 10, schema: {} });
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('DownLlmClient always fails', async () => {
    const down = new DownLlmClient();
    const result = await down.complete({ model: 'm', system: 's', userContent: 'x', maxTokens: 10, schema: {} });
    expect(result.ok).toBe(false);
  });
});
