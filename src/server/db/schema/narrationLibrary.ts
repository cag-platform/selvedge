import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';

/**
 * The graduation library (Phase 2 deliverable 4). Global (cross-org) by
 * design — phrasings carry no org data, only pack-shaped slots — with
 * per-org use counts in narration_library_uses so the graduation rule
 * ("3 uses across >=2 orgs, or 5 within one org, zero negative feedback")
 * is checkable.
 */
export const narrationLibrary = pgTable(
  'narration_library',
  {
    id: text('id').primaryKey(), // ulid
    fingerprint: text('fingerprint').notNull(),
    phrasing: jsonb('phrasing').notNull(), // NarrationOutput {fragment, technicalDetail?, verdict?}
    useCount: integer('use_count').notNull().default(0),
    negativeFeedbackCount: integer('negative_feedback_count').notNull().default(0),
    status: text('status').notNull().default('candidate'), // candidate | graduated | retired
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('narration_library_fingerprint_idx').on(table.fingerprint)],
);

export const narrationLibraryUses = pgTable(
  'narration_library_uses',
  {
    libraryId: text('library_id').notNull(),
    orgId: text('org_id').notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.libraryId, table.orgId] })],
);
