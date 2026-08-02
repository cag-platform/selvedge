import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Sketch: the cheap room next door to the workshop.
 *
 * A sketch is a conversation about an idea BEFORE anything is built — the
 * model knows what the app is and how it's been behaving, asks what's
 * unsettled, and when the idea is clear it writes the brief. That brief is
 * then handed to the workshop as the prompt, so the expensive agent runs once
 * on a well-formed instruction instead of three times while you figure out
 * what you meant.
 *
 * Deliberately its own thread, not `agent_messages`: a sketch may exist before
 * any project does, it never touches a sandbox, and mixing thinking into the
 * workshop's build conversation would muddle both.
 */

/** One idea being talked through. */
export const sketches = pgTable(
  'sketches',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    /** The project this is about — null while the idea predates a project. */
    projectId: text('project_id'),
    /** Derived from the first message; what the list shows. */
    title: text('title').notNull(),
    /** The buildable instruction, once the idea is clear enough. Null until then. */
    brief: text('brief'),
    /** Set when the brief was handed to the workshop, so the list can say so. */
    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sketches_org_updated_idx').on(t.orgId, t.updatedAt)],
);

/** The back-and-forth within one sketch. */
export const sketchMessages = pgTable(
  'sketch_messages',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    sketchId: text('sketch_id').notNull(),
    role: text('role').notNull(), // 'owner' | 'sketch'
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sketch_messages_sketch_idx').on(t.sketchId)],
);
