CREATE TABLE IF NOT EXISTS "orgs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- HAND-EDITED: `events` is physically partitioned by month on occurred_at
-- (Phase 1 brief, deliverable 1). drizzle-kit cannot express PARTITION BY in
-- its schema DSL, so this file was generated then augmented by hand. Do not
-- re-run `drizzle-kit generate` against schema/events.ts and overwrite this
-- migration — future column changes to `events` need a new hand-checked
-- migration, not a diff against this one.
--
-- Postgres requires every unique constraint on a partitioned table to
-- include the partition key, hence occurred_at riding along in both the
-- primary key and the dedupe unique index below.
CREATE TABLE IF NOT EXISTS "events" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"source" text NOT NULL,
	"source_account_id" text NOT NULL,
	"project_id" text,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"severity_hint" text NOT NULL,
	"raw" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	CONSTRAINT "events_id_occurred_at_pk" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
-- Catch-all partition so inserts never fail for a month whose partition
-- hasn't been created yet; ensurePartitions() (db/partitions.ts) creates the
-- real monthly partitions ahead of need and this stays empty in steady state.
CREATE TABLE IF NOT EXISTS "events_default" PARTITION OF "events" DEFAULT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "packs" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pack" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packs_org_id_project_id_pk" PRIMARY KEY("org_id","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_health" (
	"org_id" text NOT NULL,
	"connector" text NOT NULL,
	"source_account_id" text NOT NULL,
	"status" text DEFAULT 'fresh' NOT NULL,
	"last_event_at" timestamp with time zone,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" text,
	CONSTRAINT "connector_health_org_id_connector_source_account_id_pk" PRIMARY KEY("org_id","connector","source_account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "narrations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"path" text NOT NULL,
	"intended_path" text NOT NULL,
	"delivery" text NOT NULL,
	"kind" text,
	"fragment" text,
	"technical_detail" text,
	"verdict" text,
	"storm" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"digest_date" date NOT NULL,
	"headline" text NOT NULL,
	"sections" jsonb NOT NULL,
	"open_threads" jsonb NOT NULL,
	"rendered_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_org_dedupe_idx" ON "events" USING btree ("org_id","dedupe_key","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_org_project_idx" ON "events" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_org_occurred_idx" ON "events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "packs_org_project_idx" ON "packs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digests_org_date_idx" ON "digests" USING btree ("org_id","digest_date");