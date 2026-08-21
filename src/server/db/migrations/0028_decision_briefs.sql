-- The decision brief: what was decided, extracted from the conversation where
-- it was decided, between a thinking thread and the building thread it paired
-- with.
--
-- The evidence columns are the load-bearing part. This object's known failure
-- mode is a stale brief producing a confidently wrong verdict — the thinking
-- moves on, the decision doesn't, and something later reports that the build
-- did what was decided when the decision has since changed. So a brief records
-- exactly how much of the conversation it was made from, and everything
-- downstream compares that against the thread as it stands now. Without these
-- two columns this table should not exist.
CREATE TABLE IF NOT EXISTS "decision_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"thinking_thread_id" text NOT NULL,
	"building_thread_id" text,
	"title" text NOT NULL,
	"decision" text NOT NULL,
	"why" text,
	"constraints" jsonb,
	"open_questions" jsonb,
	"evidence_through" timestamp with time zone,
	"evidence_messages" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"edited_by_human" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_briefs_org_thinking_idx" ON "decision_briefs" ("org_id","thinking_thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_briefs_org_building_idx" ON "decision_briefs" ("org_id","building_thread_id");
