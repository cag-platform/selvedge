CREATE TABLE IF NOT EXISTS "continuation_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "state" text DEFAULT 'collecting' NOT NULL,
  "converted_thread_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "continuation_sessions_org_idx" ON "continuation_sessions" ("org_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "continuation_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "continuation_id" text NOT NULL,
  "project_id" text NOT NULL,
  "kind" text NOT NULL,
  "source_ref" text NOT NULL,
  "title" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "version" text,
  "status" text DEFAULT 'added' NOT NULL,
  "limitations" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "continuation_sources_org_session_idx" ON "continuation_sources" ("org_id","continuation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "continuation_sources_unique_ref" ON "continuation_sources" ("org_id","continuation_id","kind","source_ref");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "continuation_claims" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "continuation_id" text NOT NULL,
  "project_id" text NOT NULL,
  "claim_key" text NOT NULL,
  "claim_group" text NOT NULL,
  "text" text NOT NULL,
  "value" jsonb,
  "status" text NOT NULL,
  "confidence" text NOT NULL,
  "consequence" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "confirmed_value" jsonb,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "continuation_claims_org_session_idx" ON "continuation_claims" ("org_id","continuation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "continuation_claims_unique_key" ON "continuation_claims" ("org_id","continuation_id","claim_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handoff_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "project_id" text,
  "from_agent" text NOT NULL,
  "to_agent" text NOT NULL,
  "included" jsonb NOT NULL,
  "omitted" jsonb NOT NULL,
  "repository" jsonb NOT NULL,
  "estimated_tokens" integer NOT NULL,
  "transcript_tokens" integer NOT NULL,
  "payload_hash" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handoff_receipts_org_thread_idx" ON "handoff_receipts" ("org_id","thread_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_context_sources" (
  "org_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "source_thread_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "thread_context_sources_org_id_thread_id_source_thread_id_pk" PRIMARY KEY("org_id","thread_id","source_thread_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_context_sources_org_thread_idx" ON "thread_context_sources" ("org_id","thread_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "surface" text,
  "continuation_id" text,
  "project_id" text,
  "thread_id" text,
  "properties" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_events_org_name_idx" ON "product_events" ("org_id","name","created_at");
