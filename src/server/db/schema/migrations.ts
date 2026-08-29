import { boolean, jsonb, pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import type { MigrationPlan, MigrationProjectMap, MigrationSource, MigrationVerification } from '../../../shared/types/migration.js';

export const migrationJourneys = pgTable('migration_journeys', {
  id: text('id').primaryKey(), orgId: text('org_id').notNull(), projectId: text('project_id').notNull(),
  source: text('source').$type<MigrationSource>().notNull(), state: text('state').notNull(),
  originalUntouched: boolean('original_untouched').notNull().default(true),
  projectMap: jsonb('project_map').$type<MigrationProjectMap>().notNull(), migrationPlan: jsonb('migration_plan').$type<MigrationPlan>(), migrationVerification: jsonb('migration_verification').$type<MigrationVerification>(), destinations: jsonb('destinations').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('migration_journeys_org_project_idx').on(table.orgId, table.projectId)]);
