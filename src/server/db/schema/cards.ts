import { pgTable, text, integer, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * A work card — one row per change the loop is walking (Phase 3). Org-scoped
 * from birth. The mutable lifecycle fields (state, verdict, spent, backup) are
 * columns so they can be queried and indexed; the richer structures (estimate,
 * stop-point, the append-only acts) ride as JSONB, since only the machine reads
 * them and they never need a WHERE clause.
 *
 * The row is the persisted projection of the pure Card domain (cards/types.ts).
 * The store is the ONLY writer, and it moves state exclusively through the pure
 * machine — so the cap-and-gate guarantees proven in isolation hold against the
 * database too.
 */
export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    trigger: text('trigger').notNull(), // 'incident' | 'request'
    title: text('title').notNull(),
    proposal: text('proposal').notNull(),
    risk: text('risk').notNull(), // 'sensitive' | 'ordinary' | 'cosmetic'
    gate: text('gate').notNull(), // 'hard' | 'normal' | 'frictionless'
    state: text('state').notNull(), // CardState
    verdict: text('verdict'), // CardVerdict | null
    estimate: jsonb('estimate').notNull(), // CostEstimate
    stop: jsonb('stop').notNull(), // StopPoint
    spentCents: integer('spent_cents').notNull().default(0),
    backupVerified: boolean('backup_verified').notNull().default(false),
    acts: jsonb('acts').notNull(), // CardAct[]
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cards_org_project_idx').on(t.orgId, t.projectId)],
);
