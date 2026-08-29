import { index, pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/** Short-lived, encrypted values used only by an approved migration preview flow. */
export const migrationTestInputs = pgTable(
  'migration_test_inputs',
  {
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    journeyId: text('journey_id').notNull(),
    stepId: text('step_id').notNull(),
    inputId: text('input_id').notNull(),
    valueEnc: text('value_enc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.journeyId, t.stepId, t.inputId] }),
    index('migration_test_inputs_expiry_idx').on(t.expiresAt),
  ],
);
