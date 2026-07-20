import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Feedback taps (Phase 2 deliverable 5). Two kinds, both quiet: no
 * thumbs-up exists by design — absence of complaint is the positive signal.
 */
export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    narrationId: text('narration_id').notNull(),
    kind: text('kind').notNull(), // 'didnt_help' | 'explain_differently'
    note: text('note'), // the one-line free text for 'explain_differently'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('feedback_org_idx').on(table.orgId, table.createdAt)],
);
