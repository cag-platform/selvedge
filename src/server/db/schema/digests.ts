import { pgTable, text, date, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * One row per org per day. `sections` mirrors the digest-composer §2
 * skeleton. `openThreads` is the continuity stub: unresolved attention
 * items this digest is carrying forward, which the next digest must
 * reference the resolution of (digest-composer §1 rule 5).
 */
export const digests = pgTable(
  'digests',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    digestDate: date('digest_date').notNull(), // the local calendar day this brief covers
    headline: text('headline').notNull(),
    sections: jsonb('sections').notNull(), // { attention: [], moved: [], standing: [], quiet: [], today: [] }
    openThreads: jsonb('open_threads').notNull(), // [{ project_id, summary, narration_id }]
    renderedText: text('rendered_text').notNull(), // the note, assembled — what the Today page shows
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('digests_org_date_idx').on(table.orgId, table.digestDate)],
);
