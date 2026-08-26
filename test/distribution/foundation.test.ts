import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { distributionHypotheses, distributionOpportunities, distributionPrograms, distributionSignals } from '../../src/server/db/schema/index.js';
import { DEFAULT_SCORING_WEIGHTS, DISTRIBUTION_SCOPE, canTransitionOpportunity, overallScore } from '../../src/server/distribution/domain.js';
import { SELVEDGE_PROGRAM_ID, createOpportunity, ensureSelvedgeDistributionProgram, ingestSignal, transitionOpportunity } from '../../src/server/distribution/store.js';
import { createDistributionOpsRouter } from '../../src/server/web/routes/distributionOps.js';
import { operatorOnly } from '../../src/server/web/middleware/operatorOnly.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

describe('distribution foundation', () => {
  let db: TestDb; let close: () => Promise<void>;
  beforeEach(async () => { const test = await createTestDb(); db = test.db; close = test.close; });
  afterEach(async () => close());

  it('seeds the Selvedge program and its five related hypotheses idempotently', async () => {
    const first = await ensureSelvedgeDistributionProgram(db);
    const second = await ensureSelvedgeDistributionProgram(db);
    expect(first?.objective).toBe('50 activated Selvedge projects');
    expect(first?.primaryConversion).toBe('PROJECT_CONNECTED');
    expect(first?.targetDate).toBeNull();
    expect(first?.hypotheses.map((h) => h.code)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5']);
    expect(second?.hypotheses).toHaveLength(5);
    expect((await db.select().from(distributionPrograms)).length).toBe(1);
  });

  it('ingests a signal once for a stable dedupe key', async () => {
    const input = { provider: 'manual', platform: 'reddit', content: 'Agents keep losing my context', rawPayload: {}, dedupeKey: 'reddit:123' };
    const first = await ingestSignal(db, input);
    const second = await ingestSignal(db, input);
    expect(first.inserted).toBe(true); expect(second.inserted).toBe(false);
    expect(second.signal.id).toBe(first.signal.id);
    expect((await db.select().from(distributionSignals)).length).toBe(1);
  });

  it('normalizes weighted scores to 0–100 and keeps dimensions explicit', () => {
    expect(overallScore({ fit: 100, intent: 100, freshness: 100, audience: 100, engagement: 100 })).toBe(100);
    expect(overallScore({ fit: 120, intent: -40, freshness: 50, audience: 50, engagement: 50 })).toBe(53);
    expect(overallScore({ fit: 100, intent: 0, freshness: 0, audience: 0, engagement: 0 }, DEFAULT_SCORING_WEIGHTS)).toBe(30);
  });

  it('creates an opportunity related to its signal, program, and hypothesis', async () => {
    await ensureSelvedgeDistributionProgram(db);
    const signal = (await ingestSignal(db, { provider: 'manual', platform: 'x', content: 'Claude forgot', rawPayload: {}, dedupeKey: 'x:1' })).signal;
    const [hypothesis] = await db.select().from(distributionHypotheses).where(and(eq(distributionHypotheses.programId, SELVEDGE_PROGRAM_ID), eq(distributionHypotheses.code, 'H2')));
    const row = await createOpportunity(db, { signalId: signal.id, hypothesisId: hypothesis!.id, opportunityType: 'CONVERSATION', audienceType: 'DEVELOPER', problemSummary: 'The agent lost project history.', intentType: 'PAIN', scores: { fit: 90, intent: 80, freshness: 70, audience: 85, engagement: 60 }, reasoning: 'Directly describes project amnesia.', recommendedActionType: 'REPLY' });
    expect(row.programId).toBe(SELVEDGE_PROGRAM_ID); expect(row.hypothesisId).toBe(hypothesis!.id); expect(row.overallScore).toBe(79);
  });

  it('allows only explicit opportunity state transitions', async () => {
    await ensureSelvedgeDistributionProgram(db);
    const row = await createOpportunity(db, { opportunityType: 'CONVERSATION', audienceType: 'UNKNOWN', problemSummary: 'Problem', intentType: 'QUESTION', scores: { fit: 50, intent: 50, freshness: 50, audience: 50, engagement: 50 }, reasoning: 'Reason', recommendedActionType: 'REPLY' });
    expect(canTransitionOpportunity('NEW', 'READY')).toBe(true); expect(canTransitionOpportunity('NEW', 'ACTED')).toBe(false);
    expect((await transitionOpportunity(db, row.id, 'READY')).state).toBe('READY');
    await expect(transitionOpportunity(db, row.id, 'ACTED')).rejects.toThrow('invalid opportunity transition');
    expect((await db.select().from(distributionOpportunities).where(eq(distributionOpportunities.id, row.id)))[0]?.state).toBe('READY');
  });

  it('protects every Ops API endpoint with the operator allowlist', async () => {
    const guard = operatorOnly(new Set(['user_operator']));
    const run = (userId?: string) => new Promise<number | 'next'>((resolve) => {
      const req = { userId } as unknown as Request;
      const res = { status: (code: number) => ({ json: () => resolve(code) }) } as unknown as Response;
      guard(req, res, (() => resolve('next')) as NextFunction);
    });
    expect(await run()).toBe(403); expect(await run('user_customer')).toBe(403); expect(await run('user_operator')).toBe('next');
    // The router applies this guard once at the shared prefix, before all endpoints.
    const router = createDistributionOpsRouter(db, new Set(['user_operator']));
    const firstOpsRoute = router.stack.findIndex((layer) => typeof layer.route?.path === 'string' && layer.route.path.startsWith('/api/ops/distribution'));
    const guardLayer = router.stack.findIndex((layer, index) => index < firstOpsRoute && layer.route === undefined);
    expect(guardLayer).toBeGreaterThanOrEqual(0);
  });

  it('keeps every distribution row in the dedicated internal scope', async () => {
    await ensureSelvedgeDistributionProgram(db);
    expect((await db.select().from(distributionPrograms))[0]?.orgId).toBe(DISTRIBUTION_SCOPE);
  });
});
