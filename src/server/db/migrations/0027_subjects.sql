-- Subjects: somewhere to put work that isn't a repository.
--
-- A thread has always had to belong to a project, so conversations about
-- pricing, or hiring, or an old chat log about nothing in particular went into
-- whichever project was least wrong. That is how a project's history stops
-- being true. A subject is a name with threads under it and nothing else: no
-- stakes, no topology, no watching, no verdicts — there is nothing there to
-- monitor, and it must never look as though there were.
CREATE TABLE IF NOT EXISTS "subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_org_idx" ON "subjects" ("org_id");
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "subject_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_org_subject_idx" ON "threads" ("org_id","subject_id");
--> statement-breakpoint
-- A thread now belongs to a project OR a subject, so project_id stops being
-- required. Every row that exists today has one; nothing is being loosened
-- retroactively, only made expressible.
ALTER TABLE "threads" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
-- ...and a message in a subject's thread is about no project either.
ALTER TABLE "agent_messages" ALTER COLUMN "project_id" DROP NOT NULL;
