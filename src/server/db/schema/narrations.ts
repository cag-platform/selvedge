import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

/**
 * One row per routed-and-narrated event. This is what the digest composer
 * reads (never raw events) and what makes every Today-page item traceable
 * back to its source event (acceptance gate 2).
 */
export const narrations = pgTable('narrations', {
  id: text('id').primaryKey(), // ulid
  orgId: text('org_id').notNull(),
  projectId: text('project_id'), // null while the event sits in the unsorted tray
  eventId: text('event_id').notNull(), // loose reference into events (partitioned; see events.ts)
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  path: text('path').notNull(), // narration path actually used this phase: SILENT | TEMPLATE
  intendedPath: text('intended_path').notNull(), // SILENT | TEMPLATE | LIB | LLM | LLM+VERDICT
  delivery: text('delivery').notNull(), // NONE | DIGEST | PUSH
  kind: text('kind'), // attention | moved | standing | quiet (digest composer §2 section)
  fragment: text('fragment'), // rendered plain_only sentence(s); null when path=SILENT
  technicalDetail: text('technical_detail'), // collapsed technical line for plain_expandable
  verdict: text('verdict'), // users_affected | users_fine | cannot_tell | null
  storm: boolean('storm').notNull().default(false), // true if this row is a collapsed storm summary
  meta: jsonb('meta'), // slot values used, modifier flags applied, etc. — for debugging/expandable detail
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
