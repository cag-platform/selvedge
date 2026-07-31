import { pgTable, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * A configured health check for an app — what to probe, how, and how often.
 * Org-scoped from birth. One app can have several checks (its front page, its
 * API, a keyword that proves the page really rendered).
 *
 * This is the config the monitor reads each tick. The probe *results* are
 * events on the main pipeline, not rows here — a health outage is a
 * runtime.health_failing event that flows through routing and narration like
 * any other, which is the whole point of porting the monitor into Selvedge
 * rather than bolting on a separate status column.
 */
export const healthChecks = pgTable('health_checks', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(), // 'http' | 'tcp' | 'keyword'
  url: text('url').notNull(),
  expectedStatus: integer('expected_status'),
  keyword: text('keyword'),
  intervalSec: integer('interval_sec').notNull().default(60),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
