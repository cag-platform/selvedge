import { pgTable, text, integer, boolean, doublePrecision, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/**
 * The error beacon — the push transport that closes the error-ingest seam.
 * An app reports its per-window error/request counts to a small endpoint; a
 * spike above the app's own baseline becomes a runtime.error_rate_spike event,
 * through the same pure detector the (deferred) pull poller would use.
 *
 * Two tables, both org-scoped from birth:
 *
 *   project_beacons — one issued secret per project, stored ONLY as a SHA-256
 *   hash (never the token itself, the credentials-vault discipline applied to a
 *   bearer secret). The endpoint authenticates by hashing the presented token
 *   and looking it up here; a revoked beacon is a row delete.
 *
 *   error_rate_state — the detector's baseline and debounce state, persisted
 *   because windows arrive minutes apart and across processes, so it can't live
 *   in an in-process Map the way the poller's does.
 */

export const projectBeacons = pgTable('project_beacons', {
  orgId: text('org_id').notNull(),
  projectId: text('project_id').notNull(),
  /** SHA-256 of the issued token, hex. The token itself is shown once and never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.orgId, t.projectId] })]);

export const errorRateState = pgTable('error_rate_state', {
  orgId: text('org_id').notNull(),
  projectId: text('project_id').notNull(),
  /** Which error stream — one project can report several (default 'default'). */
  sourceId: text('source_id').notNull().default('default'),
  baseline: doublePrecision('baseline'), // null until the first window warms it
  windowsSeen: integer('windows_seen').notNull().default(0),
  consecutiveElevated: integer('consecutive_elevated').notNull().default(0),
  alerted: boolean('alerted').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgId, t.projectId, t.sourceId] })]);
