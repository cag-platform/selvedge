import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';

/**
 * The honesty ledger's Class-1 entries (Ironclad 2). One row each time Selvedge
 * emitted an all-clear that a later real signal contradicted — the "false calm"
 * the whole product forbids. Recording it is the point: owning the miss out
 * loud (a correction brief) is the single most trust-building act available,
 * and a platform that narrates its own app will never publish its own accuracy.
 */
export const trustIncidents = pgTable(
  'trust_incidents',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    kind: text('kind').notNull(), // 'false_all_clear' (Class-1)
    priorNarrationId: text('prior_narration_id'), // the users_fine / all-clear that turned out wrong
    contradictingEventId: text('contradicting_event_id'), // the later signal that contradicted it
    detail: text('detail'),
    acknowledged: boolean('acknowledged').notNull().default(false), // surfaced in a correction brief yet?
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('trust_incidents_org_idx').on(table.orgId, table.createdAt)],
);
