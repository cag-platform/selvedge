CREATE TABLE IF NOT EXISTS "project_seen_cursors" (
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "project_id" text NOT NULL,
  "seen_through" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_seen_cursors_org_id_user_id_project_id_pk" PRIMARY KEY("org_id","user_id","project_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_seen_cursors_org_project_idx" ON "project_seen_cursors" ("org_id","project_id");
