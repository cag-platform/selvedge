CREATE TABLE IF NOT EXISTS "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"trigger" text NOT NULL,
	"title" text NOT NULL,
	"proposal" text NOT NULL,
	"risk" text NOT NULL,
	"gate" text NOT NULL,
	"state" text NOT NULL,
	"verdict" text,
	"estimate" jsonb NOT NULL,
	"stop" jsonb NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"backup_verified" boolean DEFAULT false NOT NULL,
	"acts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cards_org_project_idx" ON "cards" ("org_id","project_id");
