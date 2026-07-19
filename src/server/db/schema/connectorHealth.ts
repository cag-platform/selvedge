import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * One row per installation/connection. Feeds the trust ledger (Phase 2+)
 * and Group E routing (connector auth-failure / staleness narration) today.
 */
export const connectorHealth = pgTable(
  'connector_health',
  {
    orgId: text('org_id').notNull(),
    connector: text('connector').notNull(), // ConnectorKind
    sourceAccountId: text('source_account_id').notNull(), // e.g. GitHub installation id
    status: text('status').notNull().default('fresh'), // fresh | quiet | auth_failed
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    meta: text('meta'), // free-form note (e.g. account login), plain text by design
  },
  (table) => [primaryKey({ columns: [table.orgId, table.connector, table.sourceAccountId] })],
);
