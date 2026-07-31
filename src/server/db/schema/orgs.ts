import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One row per Clerk organization. Created lazily on first authenticated
 * request (see web/middleware/orgScope.ts). Carries org-level settings that
 * don't belong on any single project pack, e.g. the timezone the daily
 * digest job uses to compute "local 7:00am".
 */
export const orgs = pgTable('orgs', {
  orgId: text('org_id').primaryKey(),
  timezone: text('timezone').notNull().default('UTC'),
  // 'default' = never set (auto-detect may overwrite) | 'auto' = detected
  // from a signed-in browser | 'user' = explicitly chosen, never overwritten.
  timezoneSource: text('timezone_source').notNull().default('default'),
  // The plan this org is on. Decides the daily model-spend cap (llm/budget.ts)
  // and, later, the included-work allowance. 'trial' | 'care' | 'studio'.
  plan: text('plan').notNull().default('care'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
