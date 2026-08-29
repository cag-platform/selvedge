import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { migrationTestInputs } from '../../src/server/db/schema/index.js';
import { configuredMigrationTestInputIds, consumeMigrationTestInputs, deleteMigrationTestInputs, storeMigrationTestInputs } from '../../src/server/import/migrationTestInputs.js';
import type { MigrationOwnerTestFlow } from '../../src/shared/types/migration.js';

describe('temporary migration test inputs', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const previousKey = process.env.CREDENTIALS_KEY;
  const flow: MigrationOwnerTestFlow = { schema_version: 1, goal: 'Sign in', status: 'ready', steps: [{ id: 'login', label: 'Sign in', detail: 'Use the test account.', boundary: 'approval_required', state: 'approved', result_detail: null, evidence_artifact_ids: [], input_requirements: [{ id: 'email', label: 'Test email', input_type: 'email', kind: 'synthetic' }, { id: 'password', label: 'Temporary password', input_type: 'password', kind: 'temporary_credential' }] }], created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z' };

  beforeEach(async () => { const test = await createTestDb(); db = test.db; close = test.close; process.env.CREDENTIALS_KEY = 'test-only-credentials-key-that-is-at-least-32-characters'; });
  afterEach(async () => { if (previousKey === undefined) delete process.env.CREDENTIALS_KEY; else process.env.CREDENTIALS_KEY = previousKey; await close(); });

  it('stores ciphertext, exposes metadata only, decrypts only for execution, and deletes the values', async () => {
    const now = new Date('2026-08-29T00:00:00Z');
    await storeMigrationTestInputs(db, 'org_1', 'project_1', 'journey_1', flow.steps[0]!, { email: 'preview@example.test', password: 'one-run-only' }, now);
    const rows = await db.select().from(migrationTestInputs);
    expect(JSON.stringify(rows)).not.toContain('preview@example.test');
    expect(JSON.stringify(rows)).not.toContain('one-run-only');
    expect(await configuredMigrationTestInputIds(db, 'org_1', 'journey_1', now)).toEqual(new Set(['login:email', 'login:password']));
    expect(await consumeMigrationTestInputs(db, 'org_1', 'journey_1', flow, now)).toEqual({ login: { email: 'preview@example.test', password: 'one-run-only' } });
    await deleteMigrationTestInputs(db, 'org_1', 'journey_1');
    expect(await db.select().from(migrationTestInputs)).toEqual([]);
  });

  it('expires values after one hour and removes the ciphertext', async () => {
    const now = new Date('2026-08-29T00:00:00Z');
    await storeMigrationTestInputs(db, 'org_1', 'project_1', 'journey_1', flow.steps[0]!, { email: 'preview@example.test' }, now);
    expect(await consumeMigrationTestInputs(db, 'org_1', 'journey_1', flow, new Date('2026-08-29T01:00:01Z'))).toEqual({});
    expect(await db.select().from(migrationTestInputs)).toEqual([]);
  });
});
