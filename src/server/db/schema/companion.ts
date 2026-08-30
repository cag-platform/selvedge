import { pgTable, text, doublePrecision, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * THE LOOP'S TWO HALVES, in one file because they share one secret.
 *
 * `companion_tokens` — what a program running on the owner's own machine
 * authenticates with. Everything else in this product authenticates as a person
 * through Clerk's session cookie; a daemon and an MCP server have no browser and
 * no person sitting behind them, so they carry a bearer token instead. Stored
 * only as a SHA-256 hash, shown exactly once at issue — the same discipline the
 * error beacon and the credentials vault use, for the same reason: a database
 * read must never recover a working key.
 *
 * `external_sessions` — a coding session Selvedge did NOT run, observed from
 * outside and summarised by the companion. This is the honest half of the loop:
 * the work happened in someone's terminal, Selvedge only heard about it
 * afterwards, and every surface that shows one says so. It carries a summary and
 * never a transcript — intent, files touched, tools run, outcome, the commit it
 * lines up with, what it cost. Raw code and full conversations stay on the
 * machine they happened on, which is a promise made in the docs and kept by the
 * shape of this table: there is nowhere here to put them.
 */

export const companionTokens = pgTable(
  'companion_tokens',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    /** What the owner called it — "my laptop", "work machine". */
    name: text('name').notNull(),
    /** SHA-256 of the issued token, hex. The token itself is shown once and never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Revoked tokens are kept, not deleted: "this key stopped working on Tuesday" is a question worth answering. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('companion_tokens_org_idx').on(t.orgId)],
);

export const externalSessions = pgTable(
  'external_sessions',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    /** Null when the session's working directory matched no project we know. */
    projectId: text('project_id'),
    /** Which tool ran it — a shared/agents.ts id. */
    agent: text('agent').notNull(),
    /** The tool's own session id, so a re-sent summary updates rather than duplicates. */
    sessionId: text('session_id').notNull(),
    /** Where it happened: the repo it was in, and the directory it ran from. */
    repo: text('repo'),
    cwd: text('cwd'),
    /** The first thing the owner asked for, bounded. Not the conversation. */
    intent: text('intent'),
    /** string[] — which files the session touched. */
    filesTouched: jsonb('files_touched'),
    /** Record<string, number> — which tools it ran, and how often. */
    toolsRun: jsonb('tools_run'),
    /** shipped | ended | abandoned | error | unreadable */
    outcome: text('outcome').notNull(),
    /** What the session left behind in git, when a commit lines up with it. */
    commitSha: text('commit_sha'),
    costUsd: doublePrecision('cost_usd'),
    /** Why a session couldn't be read — the loud half of "fail loudly, never silently". */
    detail: text('detail'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_sessions_org_agent_session_idx').on(t.orgId, t.agent, t.sessionId),
    index('external_sessions_org_project_idx').on(t.orgId, t.projectId),
  ],
);

/**
 * A Mac which has explicitly offered its Apple toolchain to Selvedge.
 *
 * The bearer key still defines the org boundary. This row stores capability
 * evidence and liveness only — never an Apple ID, signing certificate, source
 * archive or command output. A short heartbeat window makes "connected" a
 * fact about a machine that is online now, not a stale setup claim.
 */
export const appleRuntimeHosts = pgTable(
  'apple_runtime_hosts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    tokenId: text('token_id').notNull().unique(),
    name: text('name').notNull(),
    status: text('status').notNull().default('online'),
    xcodeVersion: text('xcode_version').notNull(),
    macosVersion: text('macos_version').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  },
  (t) => [index('apple_runtime_hosts_org_seen_idx').on(t.orgId, t.lastSeenAt)],
);
