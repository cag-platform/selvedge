import { pgTable, text, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * THE DECISION BRIEF — what was decided, extracted from the conversation where
 * it was decided, sitting between the thinking and the building.
 *
 * A thinking thread is long, circular and full of abandoned turns; a builder
 * handed the whole of it builds the average of every idea in it. So the pair is
 * joined by one short, human-editable statement: what we decided, why, what it
 * must not break, and what is still open.
 *
 * EVIDENCE-DATING IS NOT DECORATION. This object's known failure mode — named
 * in the brief that specified it — is a stale brief producing a confidently
 * wrong verdict: the thinking moves on, the decision doesn't, and something
 * later reports that the build did what was decided when the decision has since
 * changed. So every brief records exactly how much of the conversation it was
 * made from (`evidenceThrough`, `evidenceMessages`), and everything downstream
 * compares that against the thread as it stands now. A brief that has fallen
 * behind is not silently used: the building thread refuses to act on it until
 * someone either refreshes it or says, on the record, that they know.
 */
export const decisionBriefs = pgTable(
  'decision_briefs',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    /** The project the work belongs to. Null while the thinking is about a subject. */
    projectId: text('project_id'),
    /** Where it was decided. */
    thinkingThreadId: text('thinking_thread_id').notNull(),
    /** Where it is being built — null until someone starts the work. */
    buildingThreadId: text('building_thread_id'),

    title: text('title').notNull(),
    decision: text('decision').notNull(),
    why: text('why'),
    /** string[] — what this must not break. */
    constraints: jsonb('constraints'),
    /** string[] — what was NOT settled. Kept, because a brief that hides its own gaps is the dangerous kind. */
    openQuestions: jsonb('open_questions'),

    /** The timestamp of the newest message this was made from. */
    evidenceThrough: timestamp('evidence_through', { withTimezone: true }),
    /** How many messages it saw — so "three messages have been added since" is a fact, not an estimate. */
    evidenceMessages: integer('evidence_messages').notNull().default(0),

    extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** True once a person has changed it: their words outrank the extraction's. */
    editedByHuman: boolean('edited_by_human').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('decision_briefs_org_thinking_idx').on(t.orgId, t.thinkingThreadId),
    index('decision_briefs_org_building_idx').on(t.orgId, t.buildingThreadId),
  ],
);
