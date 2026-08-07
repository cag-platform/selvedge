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
    // Asserted as a property, not a figure: the fallback moves whenever a more
    // expensive model is priced, and pinning the number here just means this
    // test has to be edited every time rather than checking anything.
    const fallback = costUsd('claude-nonexistent-9', 1_000_000, 0);
    expect(fallback).toBeGreaterThan(costUsd('claude-fable-5', 1_000_000, 0));
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
  /**
   * The invariant the whole table rests on: the fallback is at least as
   * expensive as everything in it. Overstating an unpriced model's spend shows
   * up as a cost surprise; understating it is margin quietly leaking, which is
   * the failure nobody notices. Guards against adding an expensive row and
   * forgetting to raise the fallback under it.
   */
  it('never prices an unknown model below any model it does know', () => {
    const unknown = costUsd('a-model-nobody-priced', 1_000_000, 1_000_000);
    for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5-mini']) {
      expect(unknown).toBeGreaterThanOrEqual(costUsd(model, 1_000_000, 1_000_000));
    }
  });

  it('attributes each priced model to its provider', () => {
    expect(providerForModel('claude-opus-5')).toBe('anthropic');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
    expect(providerForModel('gpt-5.6-sol')).toBe('openai');
    expect(providerForModel('gpt-5-mini')).toBe('openai');
    expect(providerForModel('nothing-priced-this')).toBe('unknown');
  });

  it('prices an OpenAI grader from its own rates, not the incumbent’s', () => {
    // gpt-5.6-terra: $2/MTok in, $12/MTok out
    expect(costUsd('gpt-5.6-terra', 1_000_000, 0)).toBeCloseTo(2.0);
    expect(costUsd('gpt-5.6-terra', 0, 1_000_000)).toBeCloseTo(12.0);
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
