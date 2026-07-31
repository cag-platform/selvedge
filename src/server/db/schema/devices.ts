import { pgTable, text, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * One row per registered push device per org. The native app registers its
 * APNs device token here (POST /api/devices); the morning-brief scheduler and
 * the critical-routing path read these rows to know where to deliver a push.
 *
 * Keyed by (org_id, token): the same physical device re-registers idempotently
 * on every launch (tokens rotate, so re-registration is expected), and one
 * device can serve more than one org.
 */
export const devices = pgTable(
  'devices',
  {
    orgId: text('org_id').notNull(),
    token: text('token').notNull(), // APNs device token (hex)
    platform: text('platform').notNull(), // 'ios'
    environment: text('environment').notNull().default('production'), // 'sandbox' | 'production'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.token] })],
);
