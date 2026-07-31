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
    // Hide/delete states. A project auto-created from a GitHub repo can't just
    // be row-deleted — the next installation sync re-scaffolds it. `archivedAt`
    // is the permanent-delete tombstone: the row is kept so resolveProjectId
    // still maps the repo and backfill won't resurrect it, but it's filtered
    // out of every user surface. `mutedAt` is the softer "deprioritize": the
    // project stays visible (collapsed) but drops out of the daily digest.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    mutedAt: timestamp('muted_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId] }),
    uniqueIndex('packs_org_project_idx').on(table.orgId, table.projectId),
  ],
);
