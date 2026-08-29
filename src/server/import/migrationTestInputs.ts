import { and, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { migrationTestInputs } from '../db/schema/index.js';
import { decryptCredential, encryptCredential, vaultConfigured } from '../connectors/credentials/crypto.js';
import type { MigrationOwnerTestFlow } from '../../shared/types/migration.js';

const TTL_MS = 60 * 60 * 1000;
function scope(journeyId: string, stepId: string, inputId: string): string {
  return `migration-test-input:${journeyId}:${stepId}:${inputId}`;
}

export type OwnerTestInputValues = Record<string, Record<string, string>>;

export async function storeMigrationTestInputs(db: Db, orgId: string, projectId: string, journeyId: string, step: MigrationOwnerTestFlow['steps'][number], values: Record<string, string>, now = new Date()): Promise<void> {
  if (!vaultConfigured()) throw new Error('This deployment cannot safely store temporary test values.');
  const allowed = new Set((step.input_requirements ?? []).map((item) => item.id));
  const entries = Object.entries(values).filter(([id, value]) => allowed.has(id) && typeof value === 'string' && value.length > 0 && value.length <= 4_000);
  if (!entries.length) throw new Error('Provide at least one requested test value.');
  await db.delete(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), lte(migrationTestInputs.expiresAt, now)));
  const expiresAt = new Date(now.getTime() + TTL_MS);
  for (const [inputId, value] of entries) {
    const valueEnc = encryptCredential(orgId, scope(journeyId, step.id, inputId), value);
    await db.insert(migrationTestInputs).values({ orgId, projectId, journeyId, stepId: step.id, inputId, valueEnc, createdAt: now, expiresAt }).onConflictDoUpdate({ target: [migrationTestInputs.orgId, migrationTestInputs.journeyId, migrationTestInputs.stepId, migrationTestInputs.inputId], set: { valueEnc, createdAt: now, expiresAt } });
  }
}

export async function configuredMigrationTestInputIds(db: Db, orgId: string, journeyId: string, now = new Date()): Promise<Set<string>> {
  await db.delete(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), lte(migrationTestInputs.expiresAt, now)));
  const rows = await db.select({ stepId: migrationTestInputs.stepId, inputId: migrationTestInputs.inputId }).from(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), eq(migrationTestInputs.journeyId, journeyId), gt(migrationTestInputs.expiresAt, now)));
  return new Set(rows.map((row) => `${row.stepId}:${row.inputId}`));
}

export async function consumeMigrationTestInputs(db: Db, orgId: string, journeyId: string, flow: MigrationOwnerTestFlow, now = new Date()): Promise<OwnerTestInputValues> {
  await db.delete(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), lte(migrationTestInputs.expiresAt, now)));
  const rows = await db.select().from(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), eq(migrationTestInputs.journeyId, journeyId), gt(migrationTestInputs.expiresAt, now)));
  const allowed = new Set(flow.steps.flatMap((step) => (step.input_requirements ?? []).map((input) => `${step.id}:${input.id}`)));
  const values: OwnerTestInputValues = {};
  for (const row of rows) {
    if (!allowed.has(`${row.stepId}:${row.inputId}`)) continue;
    values[row.stepId] ??= {};
    values[row.stepId]![row.inputId] = decryptCredential(orgId, scope(journeyId, row.stepId, row.inputId), row.valueEnc);
  }
  return values;
}

export async function deleteMigrationTestInputs(db: Db, orgId: string, journeyId: string): Promise<void> {
  await db.delete(migrationTestInputs).where(and(eq(migrationTestInputs.orgId, orgId), eq(migrationTestInputs.journeyId, journeyId)));
}
