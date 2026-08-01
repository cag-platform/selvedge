CREATE TABLE IF NOT EXISTS "project_build" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sandbox_id" text,
	"claude_session_id" text,
	"repo_full_name" text,
	"branch" text DEFAULT 'main' NOT NULL,
	"preview_url" text,
	"preview_token" text,
	"preview_token_expires_at" timestamp with time zone,
	"staged_changes_ready" boolean DEFAULT false NOT NULL,
	"agent_model" text DEFAULT 'sonnet' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_build_org_id_project_id_pk" PRIMARY KEY("org_id","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"cost_cents" integer,
	"commit_sha" text,
	"verdict" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_org_project_idx" ON "agent_messages" ("org_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_org_project_idx" ON "agent_runs" ("org_id","project_id");
