import { pgTable, text, integer, timestamp, index, doublePrecision } from 'drizzle-orm/pg-core';

/**
 * One row per model call — margin lives or dies on this table (Phase 2
 * brief). Written by the metering layer for every call, success or failure
 * (a timed-out call still consumed tokens up to the point of failure when
 * the API reports them). The admin cost dashboard aggregates per org per day.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    purpose: text('purpose').notNull(), // 'fragment' | 'compose' | 'gist' | 'sketch' | 'grade'
    model: text('model').notNull(),
    /**
     * Who served the call — 'anthropic' | 'openai' | ... | 'unknown'. Model ids
     * are not namespaced by provider, so without this a second provider's spend
     * is indistinguishable from the incumbent's. Defaults to 'anthropic'
     * because every row written before this column existed was Anthropic's.
     */
    provider: text('provider').notNull().default('anthropic'),
    tokensIn: integer('tokens_in').notNull(),
    tokensOut: integer('tokens_out').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    eventId: text('event_id'), // the event this fragment narrated, when applicable
    ok: text('ok').notNull().default('true'), // 'true' | failure reason
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('llm_usage_org_created_idx').on(table.orgId, table.createdAt)],
);
