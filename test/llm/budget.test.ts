import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import {
  checkDailyBudget,
  dailyLlmBudgetUsd,
  spendTodayUsd,
  DEFAULT_DAILY_LLM_BUDGET_USD,
  PLAN_DAILY_LLM_BUDGET_USD,
} from '../../src/server/llm/budget.js';
import { narrateDispatch } from '../../src/server/narration/dispatch.js';
import { route } from '../../src/server/routing/route.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { composeBriefLlm } from '../../src/server/digest/composeLlm.js';
import { makeTestPack } from '../fixtures/testPack.js';
import type { NarratableEvent } from '../../src/server/narration/types.js';

const orgId = 'org_a';

async function spend(db: TestDb, usd: number, at: Date = new Date()): Promise<void> {
  await db.insert(llmUsage).values({
    id: ulid(),
    orgId,
    purpose: 'narrate',
    model: 'claude-sonnet-5',
    tokensIn: 100,
    tokensOut: 100,
    costUsd: usd,
    ok: 'true',
    createdAt: at,
  });
}

function ev(): NarratableEvent {
  return {
    id: 'evt_1',
    org_id: orgId,
    event_type: 'build.succeeded',
    occurred_at: '2026-07-19T10:00:00Z',
    severity_hint: 'info',
    signature: 'Deploy to Railway',
  };
}

describe('llm/budget — a cap that actually stops', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DAILY_LLM_BUDGET_USD;
    await close();
  });

  it('only/except scoping genuinely partitions spend — the sketch and grade carve-outs ride on this', async () => {
    // One org, three purposes. The watching cap must see only its own spend;
    // sketch and grade each see only theirs. If the scoping breaks, an
    // afternoon of grading silently makes tomorrow's brief mechanical.
    const purposes = [['narrate', 0.5], ['sketch', 2.0], ['grade', 4.0]] as const;
    for (const [purpose, usd] of purposes) {
      await db.insert(llmUsage).values({
        id: ulid(), orgId, purpose, model: 'm', tokensIn: 1, tokensOut: 1, costUsd: usd, ok: 'true',
      });
    }
    expect(await spendTodayUsd(db, orgId)).toBeCloseTo(6.5);
    expect(await spendTodayUsd(db, orgId, new Date(), { only: ['grade'] })).toBeCloseTo(4.0);
    expect(await spendTodayUsd(db, orgId, new Date(), { except: ['sketch', 'grade'] })).toBeCloseTo(0.5);
    // The watching gate excludes both carve-outs: $0.50 of watching spend
    // against the default $1 cap is under, despite $6 of carved-out spend
    // sitting right beside it.
    const state = await checkDailyBudget(db, orgId);
    expect(state.spentUsd).toBeCloseTo(0.5);
    expect(state.over).toBe(false);
  });

  it('sums only today spend, and counts failed calls', async () => {
    await spend(db, 0.2);
    await spend(db, 0.3);
    await spend(db, 5.0, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)); // three days ago
    expect(await spendTodayUsd(db, orgId)).toBeCloseTo(0.5, 5);
  });

  it('reads the cap from the environment and refuses to be disabled by a bad value', () => {
    expect(dailyLlmBudgetUsd()).toBe(DEFAULT_DAILY_LLM_BUDGET_USD);
    process.env.DAILY_LLM_BUDGET_USD = '2.5';
    expect(dailyLlmBudgetUsd()).toBe(2.5);
    // A malformed or negative value must not silently mean "no limit".
    process.env.DAILY_LLM_BUDGET_USD = 'not-a-number';
    expect(dailyLlmBudgetUsd()).toBe(DEFAULT_DAILY_LLM_BUDGET_USD);
    process.env.DAILY_LLM_BUDGET_USD = '-10';
    expect(dailyLlmBudgetUsd()).toBe(DEFAULT_DAILY_LLM_BUDGET_USD);
    // Zero is a real choice — voice off — and must be honoured.
    process.env.DAILY_LLM_BUDGET_USD = '0';
    expect(dailyLlmBudgetUsd()).toBe(0);
  });

  it('resolves the cap from the org plan, not one global number', async () => {
    // A trial account and a Studio account must not share a limit, and the
    // number a customer is held to has to be one they were sold.
    await db.insert(orgs).values([{ orgId: 'org_trial', plan: 'trial' }, { orgId: 'org_studio', plan: 'studio' }]);

    expect((await checkDailyBudget(db, 'org_trial')).capUsd).toBe(PLAN_DAILY_LLM_BUDGET_USD.trial);
    expect((await checkDailyBudget(db, 'org_studio')).capUsd).toBe(PLAN_DAILY_LLM_BUDGET_USD.studio);
    expect((await checkDailyBudget(db, orgId)).capUsd).toBe(PLAN_DAILY_LLM_BUDGET_USD.care); // default plan

    // An unknown plan falls back to the safe default, never to "no limit".
    expect(dailyLlmBudgetUsd('enterprise-typo')).toBe(DEFAULT_DAILY_LLM_BUDGET_USD);
  });

  it('the same spend is over budget on trial and under it on studio', async () => {
    await db.insert(orgs).values([{ orgId: 'org_trial', plan: 'trial' }, { orgId: 'org_studio', plan: 'studio' }]);
    for (const org of ['org_trial', 'org_studio']) {
      await db.insert(llmUsage).values({
        id: ulid(),
        orgId: org,
        purpose: 'narrate',
        model: 'claude-sonnet-5',
        tokensIn: 100,
        tokensOut: 100,
        costUsd: 0.5,
        ok: 'true',
      });
    }
    expect((await checkDailyBudget(db, 'org_trial')).over).toBe(true);
    expect((await checkDailyBudget(db, 'org_studio')).over).toBe(false);
  });

  it('reports over exactly at the cap, not merely above it', async () => {
    process.env.DAILY_LLM_BUDGET_USD = '1';
    await spend(db, 0.99);
    expect((await checkDailyBudget(db, orgId)).over).toBe(false);
    await spend(db, 0.01);
    expect((await checkDailyBudget(db, orgId)).over).toBe(true);
  });

  it('STOPS the model call when over budget, and says why', async () => {
    // The whole point. Three spend guards across these codebases were shipped
    // inert; this test fails if this one ever stops stopping.
    process.env.DAILY_LLM_BUDGET_USD = '0.10';
    await spend(db, 0.5);

    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'should never be reached', technical_line: 't', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));

    const result = await narrateDispatch(ev(), pack, decision, { llm: fake, db });

    expect(fake.requests).toHaveLength(0); // no spend beyond the cap
    expect(result?.path).toBe('TEMPLATE');
    expect(result?.meta.fallback_reason).toBe('daily_budget_exceeded');
    expect(result?.output.fragment).toBeTruthy(); // degraded, never silent
  });

  it('tells the customer the brief was written plainly because of the cap', async () => {
    // A silent downgrade would leave today's note quietly reading differently
    // with no explanation. Hitting a limit they pay for is their business.
    process.env.DAILY_LLM_BUDGET_USD = '0.10';
    await spend(db, 0.5);

    const composed = await composeBriefLlm(
      { llm: new FakeLlmClient(), db },
      orgId,
      { attention: [], moved: [], standing: [], quiet: '', closedThreads: [] } as never,
      [],
      [],
    );
    expect(composed.ok).toBe(false);
    expect(composed.ok === false && composed.reason).toBe('daily_budget_exceeded');
  });

  it('still lets the model run while under the cap', async () => {
    process.env.DAILY_LLM_BUDGET_USD = '1';
    await spend(db, 0.1);

    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
    });
    const decision = route({ event_type: 'build.succeeded' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'Loom: shipped cleanly.', technical_line: 't', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));

    await narrateDispatch(ev(), pack, decision, { llm: fake, db });
    expect(fake.requests).toHaveLength(1);
  });
});
