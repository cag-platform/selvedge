CREATE TABLE IF NOT EXISTS "sketches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"title" text NOT NULL,
	"brief" text,
	"handed_off_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sketches_org_updated_idx" ON "sketches" ("org_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sketch_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sketch_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sketch_messages_sketch_idx" ON "sketch_messages" ("sketch_id");
