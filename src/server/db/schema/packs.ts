import { pgTable, text, jsonb, timestamp, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * One JSONB row per project per org. `pack` is validated on every write
 * against docs/context-pack.schema.json (see src/server/packs/validate.ts)
 * before it touches this table.
 */
export const packs = pgTable(
  'packs',
  {
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    pack: jsonb('pack').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId] }),
    uniqueIndex('packs_org_project_idx').on(table.orgId, table.projectId),
  ],
);
