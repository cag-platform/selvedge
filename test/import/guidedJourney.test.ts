import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planMigrationGuidedJourney } from '../../src/server/import/guidedJourney.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import type { LlmClient } from '../../src/server/llm/types.js';

describe('guided migration journey planner', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1', plan: 'studio' });
  });
  afterEach(async () => close());

  it('accepts only unique allowlisted controls from the model plan', async () => {
    const llm: LlmClient = { complete: async () => ({ ok: true, json: { name: 'Inspect navigation', steps: [
      { candidate_id: 'control-1', intent: 'Open the menu' },
      { candidate_id: 'unknown', intent: 'Do something else' },
      { candidate_id: 'control-1', intent: 'Click it twice' },
      { candidate_id: 'control-2', intent: 'Switch views' },
    ] }, tokensIn: 10, tokensOut: 10, model: 'gpt-5.6-luna', provider: 'openai' }) };
    const plan = await planMigrationGuidedJourney(db, 'org_1', [
      { id: 'control-1', label: 'Menu', kind: 'button' },
      { id: 'control-2', label: 'Grid view', kind: 'button' },
    ], llm);
    expect(plan).toEqual({ name: 'Inspect navigation', steps: [
      { candidateId: 'control-1', intent: 'Open the menu' },
      { candidateId: 'control-2', intent: 'Switch views' },
    ] });
  });

  it('needs no model when the page exposes no safe controls', async () => {
    await expect(planMigrationGuidedJourney(db, 'org_1', [], undefined)).resolves.toEqual({ name: 'No safe interaction needed', steps: [] });
  });
});
