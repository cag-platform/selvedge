import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Sources the owner has told Selvedge to stop asking about.
 *
 * A row rather than a flag on the events, because it has to cover events that
 * haven't arrived yet — otherwise tomorrow's push from a repo you dismissed is
 * back in the tray, which is the "it asked me twice" failure the tray exists
 * to avoid. Deleting the row restores everything from that source at once.
 */
export const ignoredSources = pgTable(
  'ignored_sources',
  {
    orgId: text('org_id').notNull(),
    connector: text('connector').notNull(), // ConnectorKind
    resourceId: text('resource_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.connector, t.resourceId] })],
);
