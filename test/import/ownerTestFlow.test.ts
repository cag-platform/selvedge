import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveOwnerTestFlowStep, createOwnerTestFlow } from '../../src/server/import/ownerTestFlow.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import type { LlmClient } from '../../src/server/llm/types.js';

describe('owner-defined migration test flow', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const test = await createTestDb(); db = test.db; close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
  });
  afterEach(async () => close());

  it('forces consequential steps behind approval even when the model calls them automatic', async () => {
    const llm: LlmClient = { complete: async () => ({ ok: true, json: { steps: [
      { label: 'Open dashboard', detail: 'View the dashboard.', boundary: 'automatic' },
      { label: 'Create a draft', detail: 'Submit the new project form.', boundary: 'automatic' },
    ] }, tokensIn: 5, tokensOut: 5, model: 'gpt-5.6-luna', provider: 'openai' }) };
    const flow = await createOwnerTestFlow(db, 'org_1', 'Sign in and create a draft project', new Date('2026-08-29T00:00:00Z'), llm);
    expect(flow?.status).toBe('approval_required');
    expect(flow?.steps.map((step) => step.boundary)).toEqual(['automatic', 'approval_required']);
    const approved = approveOwnerTestFlowStep(flow!, flow!.steps[1]!.id, new Date('2026-08-29T00:01:00Z'));
    expect(approved?.status).toBe('ready');
    expect(approved?.steps[1]?.state).toBe('approved');
  });
});
