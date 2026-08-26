import { pgTable, text, timestamp, jsonb, index, integer, primaryKey } from 'drizzle-orm/pg-core';

export const continuationSessions = pgTable('continuation_sessions', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id').notNull(),
  state: text('state').notNull().default('collecting'),
  convertedThreadId: text('converted_thread_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('continuation_sessions_org_idx').on(t.orgId, t.createdAt)]);

export const continuationSources = pgTable('continuation_sources', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  continuationId: text('continuation_id').notNull(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(),
  sourceRef: text('source_ref').notNull(),
  title: text('title').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  version: text('version'),
  status: text('status').notNull().default('added'),
  limitations: jsonb('limitations'),
  content: text('content'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('continuation_sources_org_session_idx').on(t.orgId, t.continuationId)]);

export const continuationClaims = pgTable('continuation_claims', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  continuationId: text('continuation_id').notNull(),
  projectId: text('project_id').notNull(),
  claimKey: text('claim_key').notNull(),
  claimGroup: text('claim_group').notNull(),
  text: text('text').notNull(),
  value: jsonb('value'),
  status: text('status').notNull(),
  confidence: text('confidence').notNull(),
  consequence: text('consequence').notNull(),
  evidence: jsonb('evidence').notNull(),
  confirmedValue: jsonb('confirmed_value'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('continuation_claims_org_session_idx').on(t.orgId, t.continuationId)]);

export const handoffReceipts = pgTable('handoff_receipts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  threadId: text('thread_id').notNull(),
  projectId: text('project_id'),
  fromAgent: text('from_agent').notNull(),
  toAgent: text('to_agent').notNull(),
  included: jsonb('included').notNull(),
  omitted: jsonb('omitted').notNull(),
  repository: jsonb('repository').notNull(),
  estimatedTokens: integer('estimated_tokens').notNull(),
  transcriptTokens: integer('transcript_tokens').notNull(),
  payloadHash: text('payload_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('handoff_receipts_org_thread_idx').on(t.orgId, t.threadId, t.createdAt)]);

/** Durable links from a continuation-created thread to the exact imported
 * conversations its owner reviewed. The source remains an ordinary thread;
 * this is only the instruction to carry it on every turn. */
export const threadContextSources = pgTable('thread_context_sources', {
  orgId: text('org_id').notNull(),
  threadId: text('thread_id').notNull(),
  sourceThreadId: text('source_thread_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.threadId, t.sourceThreadId] }),
  index('thread_context_sources_org_thread_idx').on(t.orgId, t.threadId),
]);

/** Privacy-bounded funnel telemetry: event names and structural metadata only.
 * Imported text, prompts, filenames and claim contents never belong here. */
export const productEvents = pgTable('product_events', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  surface: text('surface'),
  continuationId: text('continuation_id'),
  projectId: text('project_id'),
  threadId: text('thread_id'),
  properties: jsonb('properties'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('product_events_org_name_idx').on(t.orgId, t.name, t.createdAt)]);

/** Explicit per-person read cursor. GET never touches it; only the acknowledge
 * route advances it, so opening a background refresh cannot mark work read. */
export const projectSeenCursors = pgTable('project_seen_cursors', {
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  projectId: text('project_id').notNull(),
  seenThrough: timestamp('seen_through', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.userId, t.projectId] }),
  index('project_seen_cursors_org_project_idx').on(t.orgId, t.projectId),
]);
