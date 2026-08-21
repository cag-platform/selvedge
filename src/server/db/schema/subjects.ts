import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * A SUBJECT — somewhere to put work that isn't a repository.
 *
 * Threads have always hung off projects, and a project is a codebase Selvedge
 * watches. That covers building; it doesn't cover the pricing argument, the
 * hiring note, or three years of old chats that belong to a topic rather than
 * to any app. Those threads had nowhere to live, so they went into whichever
 * project was least wrong — which is how a project's history stops being true.
 *
 * A subject is deliberately thin: a name, and threads under it. No stakes, no
 * topology, no watching, no verdicts — nothing about a subject is ever
 * monitored, because there is nothing to monitor. It is a place to keep
 * conversations, and it earns its existence only by keeping them out of the
 * projects they don't belong to.
 */
export const subjects = pgTable(
  'subjects',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    /** What it's for, in the owner's words. Optional; a name is usually enough. */
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Archived, never deleted — the threads under it are still the record. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('subjects_org_idx').on(t.orgId)],
);
