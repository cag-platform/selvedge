import { pgTable, text, integer, boolean, timestamp, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * The builder's state (Toile integration, Phase A). This is the workshop half of
 * Selvedge: the per-project sandbox, the chat thread with the agent, and the
 * record of each build run. Ported from Toile's projects/messages/build_runs,
 * reshaped to Selvedge's tenancy (org-scoped from birth — Toile was single-user)
 * and conventions (ulid ids, costs in whole cents).
 *
 * A Selvedge project already exists as a pack (its identity + watch config); this
 * is the build state attached to that same (orgId, projectId), never a second
 * project model. The status surface and the workshop share one project.
 */

/** One row per project that has (or has had) a build sandbox. */
export const projectBuild = pgTable(
  'project_build',
  {
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    /** The live Daytona sandbox id, or null when none is running. */
    sandboxId: text('sandbox_id'),
    /** The Claude Code session id, for --resume so iteration continues the conversation. */
    claudeSessionId: text('claude_session_id'),
    /** The GitHub repo the sandbox works in, and the branch. */
    repoFullName: text('repo_full_name'),
    branch: text('branch').notNull().default('main'),
    /** The live preview URL for the sandbox app, and its signed token. */
    previewUrl: text('preview_url'),
    previewToken: text('preview_token'),
    previewTokenExpiresAt: timestamp('preview_token_expires_at', { withTimezone: true }),
    /** The unique subdomain label this project's preview is served from (preview proxy). */
    previewSlug: text('preview_slug'),
    /** Set when an edit left changes ready to ship; cleared on ship or sandbox loss. */
    stagedChangesReady: boolean('staged_changes_ready').notNull().default(false),
    /** Claude model alias the agent runs under (haiku | sonnet | opus). */
    agentModel: text('agent_model').notNull().default('sonnet'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.projectId] })],
);

/** The chat thread between the owner and the agent, per project. */
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    /** The thread this message belongs to. Null only on rows written before threads existed
     *  that migration 0022 somehow missed; every writer names a thread. */
    threadId: text('thread_id'),
    role: text('role').notNull(), // 'owner' | 'agent' | 'activity'
    content: text('content').notNull(),
    /** Structured activity (tool uses, diffs) for the streaming thread; null for plain text. */
    meta: jsonb('meta'),
    /** The agent run this message belongs to — makes the thread and the runs joinable. Null on pre-recorder rows. */
    runId: text('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_messages_org_project_idx').on(t.orgId, t.projectId),
    index('agent_messages_thread_idx').on(t.orgId, t.threadId),
  ],
);

/**
 * Bytes for an image the owner attached to a workshop message (a screenshot,
 * a mockup) — kept separate from agent_messages so listing the thread never
 * has to move base64 blobs around. Non-image files (docs, zips) are NOT
 * stored here: they're transient input, written straight into the sandbox
 * for that turn and never persisted (per Toile's design — the sandbox is the
 * record of what was added, not the database).
 */
export const agentMessageAttachments = pgTable(
  'agent_message_attachments',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    agentMessageId: text('agent_message_id').notNull(),
    mime: text('mime').notNull(),
    dataBase64: text('data_base64').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_message_attachments_message_idx').on(t.agentMessageId)],
);

/** One row per agent run — a build/fix turn, with its cost and outcome. */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(), // ulid
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    /** The thread this run belongs to — the conversation the work was asked for in.
     *  A ship's run row carries it, and the ship's commit carries the same id as a
     *  git trailer, so commit -> session resolves from either side. */
    threadId: text('thread_id'),
    prompt: text('prompt').notNull(),
    model: text('model'),
    status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | cancelled
    /** What the run cost, in whole US cents (Selvedge's money convention). */
    costCents: integer('cost_cents'),
    commitSha: text('commit_sha'),
    /** The five-value verdict when the run was verified; null otherwise. */
    verdict: text('verdict'),
    /** The files this run touched (string[]); the diff the ship gate judged. Null on pre-recorder rows. */
    changedPaths: jsonb('changed_paths'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_runs_org_project_idx').on(t.orgId, t.projectId),
    index('agent_runs_thread_idx').on(t.orgId, t.threadId),
  ],
);
