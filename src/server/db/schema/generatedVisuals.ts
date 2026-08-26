import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Durable metadata for an image produced inside a conversation. */
export const generatedVisuals = pgTable(
  'generated_visuals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    threadId: text('thread_id').notNull(),
    messageId: text('message_id'),
    consultationId: text('consultation_id'),
    directingAgent: text('directing_agent').notNull(),
    renderingProvider: text('rendering_provider').notNull(),
    renderingModel: text('rendering_model').notNull(),
    status: text('status').notNull().default('queued'),
    request: text('request').notNull(),
    renderPrompt: text('render_prompt'),
    storageKey: text('storage_key'),
    mime: text('mime'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    directionMs: integer('direction_ms'),
    renderMs: integer('render_ms'),
    storageMs: integer('storage_ms'),
    error: text('error'),
    parentId: text('parent_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('generated_visuals_org_thread_idx').on(table.orgId, table.threadId),
    index('generated_visuals_consultation_idx').on(table.orgId, table.consultationId),
  ],
);
