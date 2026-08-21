-- The Loop: what a program on the owner's own machine authenticates with, and
-- what it reports.
--
-- companion_tokens: every other caller in this product is a person with a Clerk
-- session; a daemon has no browser. Only the hash is stored, so a database read
-- can never recover a working key — the beacon's discipline, applied again.
-- Revoked tokens are kept rather than deleted, because "this key stopped
-- working on Tuesday" is a question worth being able to answer.
CREATE TABLE IF NOT EXISTS "companion_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companion_tokens_org_idx" ON "companion_tokens" ("org_id");
--> statement-breakpoint
-- external_sessions: a coding session Selvedge did not run. A SUMMARY only —
-- there is deliberately nowhere in this table to put a transcript or a diff,
-- because the promise made in the docs ("raw code and full conversations never
-- leave your machine") should be kept by the shape of the schema and not only
-- by the daemon's good behaviour.
CREATE TABLE IF NOT EXISTS "external_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"repo" text,
	"cwd" text,
	"intent" text,
	"files_touched" jsonb,
	"tools_run" jsonb,
	"outcome" text NOT NULL,
	"commit_sha" text,
	"cost_usd" double precision,
	"detail" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One row per session, however many times the companion re-sends it.
CREATE UNIQUE INDEX IF NOT EXISTS "external_sessions_org_agent_session_idx" ON "external_sessions" ("org_id","agent","session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_sessions_org_project_idx" ON "external_sessions" ("org_id","project_id");
