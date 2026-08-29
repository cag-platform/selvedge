import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveOwnerTestFlowStep, createOwnerTestFlow } from '../../src/server/import/ownerTestFlow.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import type { LlmClient } from '../../src/server/llm/types.js';
import { chooseOwnerStepAction } from '../../src/server/import/ownerTestFlowRunner.js';

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
      { label: 'Create a draft', detail: 'Submit the new project form.', boundary: 'automatic', inputs: [{ id: 'project_name', label: 'Draft project name', input_type: 'text', kind: 'synthetic' }] },
    ] }, tokensIn: 5, tokensOut: 5, model: 'gpt-5.6-luna', provider: 'openai' }) };
    const flow = await createOwnerTestFlow(db, 'org_1', 'Sign in and create a draft project', new Date('2026-08-29T00:00:00Z'), llm);
    expect(flow?.status).toBe('approval_required');
    expect(flow?.steps.map((step) => step.boundary)).toEqual(['automatic', 'approval_required']);
    expect(flow?.steps[1]?.input_requirements).toEqual([{ id: 'project_name', label: 'Draft project name', input_type: 'text', kind: 'synthetic' }]);
    const approved = approveOwnerTestFlowStep(flow!, flow!.steps[1]!.id, new Date('2026-08-29T00:01:00Z'));
    expect(approved?.status).toBe('ready');
    expect(approved?.steps[1]?.state).toBe('approved');
  });

  it('executes only a control that remains in the server allowlist', async () => {
    const llm: LlmClient = { complete: async () => ({ ok: true, json: { candidate_id: 'unknown', reason: 'Invented control' }, tokensIn: 1, tokensOut: 1, model: 'gpt-5.6-luna', provider: 'openai' }) };
    const step = { id: 'step_1', label: 'Open dashboard', detail: 'View it.', boundary: 'automatic' as const, state: 'ready' as const, result_detail: null, evidence_artifact_ids: [] };
    await expect(chooseOwnerStepAction(db, 'org_1', step, [{ id: 'allowed', label: 'Dashboard', action: 'navigate', targetUrl: 'https://preview.example/dashboard' }], llm)).resolves.toBeNull();
  });
});
