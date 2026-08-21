import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * A conversation inside a project. The unit of work: what the rail lists, what
 * the composer writes into, what a handoff carries across when the agent
 * changes mid-task.
 *
 * `kind` is the real fork — 'workshop' runs a coding agent in the project's
 * sandbox and can ship; 'general' is direct model calls with no sandbox and
 * nothing to ship. `agent` and `model` are the thread's CURRENT settings, not
 * its history: a thread that switched builders mid-way records the switch on
 * its own timeline (and, for a workshop thread, the handoff payload's real
 * token count and cost), while this column simply says who is answering now.
 *
 * Threads are archived, never deleted — the record is the product.
 */
export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(), // ulid; legacy rows carry the derived id migration 0022 minted
    orgId: text('org_id').notNull(),
    /**
     * The project this conversation is about — null when it belongs to a
     * SUBJECT instead (subjects.ts). Exactly one of the two is set; a thread
     * with neither would be a conversation about nothing, filed nowhere.
     */
    projectId: text('project_id'),
    subjectId: text('subject_id'),
    /** 'workshop' | 'general' — see shared/types/thread.ts. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** An id from the agent registry (shared/agents.ts). */
    agent: text('agent').notNull(),
    /** The model alias behind that agent, when it has one; null means the agent's default. */
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * Provenance for a thread that came out of somebody else's product
     * ('chatgpt' | 'claude' | 'gemini'), with that product's own id for it.
     * Null on everything said to Selvedge itself. The pair is uniquely indexed,
     * so importing the same export twice cannot double the history — the
     * database enforces that, not the importer's memory.
     */
    importedFrom: text('imported_from'),
    importSourceId: text('import_source_id'),
  },
  (t) => [
    index('threads_org_project_idx').on(t.orgId, t.projectId),
    index('threads_org_subject_idx').on(t.orgId, t.subjectId),
  ],
);
