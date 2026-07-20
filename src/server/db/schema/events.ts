import { pgTable, text, timestamp, jsonb, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core';

/**
 * Append-only event envelope. Physically partitioned by month on
 * `occurred_at` (see the hand-edited migration in db/migrations — drizzle-kit
 * cannot express PARTITION BY declaratively, so the generated DDL is
 * augmented by hand and must not be regenerated for this table).
 *
 * Postgres requires the partition key to be part of every unique
 * constraint, hence the primary key and the dedupe unique index both
 * include `occurred_at`. Webhook retries redeliver the identical original
 * payload (same occurred_at), so this does not weaken idempotency.
 *
 * `raw` is stored and never read by any layer downstream of the connector
 * that wrote it.
 */
export const events = pgTable(
  'events',
  {
    id: text('id').notNull(),
    orgId: text('org_id').notNull(),
    source: text('source').notNull(), // ConnectorKind
    sourceAccountId: text('source_account_id').notNull(),
    projectId: text('project_id'), // null until resolved
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    severityHint: text('severity_hint').notNull(), // 'info' | 'warn' | 'error'
    raw: jsonb('raw').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.occurredAt] }),
    uniqueIndex('events_org_dedupe_idx').on(table.orgId, table.dedupeKey, table.occurredAt),
    index('events_org_project_idx').on(table.orgId, table.projectId),
    index('events_org_occurred_idx').on(table.orgId, table.occurredAt),
  ],
);
