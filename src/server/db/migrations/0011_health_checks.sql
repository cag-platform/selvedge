CREATE TABLE IF NOT EXISTS "health_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"expected_status" integer,
	"keyword" text,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_checks_org_enabled_idx" ON "health_checks" ("org_id","enabled");
