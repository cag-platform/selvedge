-- Threads: one project, many conversations.
--
-- Before this, a project had exactly one conversation and every message simply
-- belonged to (org, project). This adds the thread as a first-class object and
-- moves that single conversation into thread #1 of its project, so nothing is
-- lost and nothing has to be re-explained.
--
-- The backfilled thread's id is DERIVED from (org, project) rather than minted,
-- for two reasons: the whole file is then re-runnable (every statement in it is
-- guarded, and a second pass inserts nothing and changes nothing), and every
-- legacy message maps to exactly one thread by construction rather than by a
-- lookup that could go wrong halfway through a live database. Threads created
-- after this migration carry ordinary ulids.
CREATE TABLE IF NOT EXISTS "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"agent" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_org_project_idx" ON "threads" ("org_id","project_id");
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "thread_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_thread_idx" ON "agent_messages" ("org_id","thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_thread_idx" ON "agent_runs" ("org_id","thread_id");
--> statement-breakpoint
-- Thread #1 for every project that has ever had a workshop conversation, a run,
-- or a sandbox. Its birthday is the oldest thing it holds, so the rail's dates
-- read true rather than all saying "today, at deploy time".
WITH known AS (
	SELECT "org_id", "project_id", min("created_at") AS "first_at" FROM "agent_messages" GROUP BY "org_id", "project_id"
	UNION ALL
	SELECT "org_id", "project_id", min("created_at") AS "first_at" FROM "agent_runs" GROUP BY "org_id", "project_id"
	UNION ALL
	SELECT "org_id", "project_id", "updated_at" AS "first_at" FROM "project_build"
), rolled AS (
	SELECT "org_id", "project_id", min("first_at") AS "first_at" FROM known GROUP BY "org_id", "project_id"
)
INSERT INTO "threads" ("id", "org_id", "project_id", "kind", "title", "agent", "model", "created_at")
SELECT
	'thread_' || md5(r."org_id" || ':' || r."project_id"),
	r."org_id",
	r."project_id",
	'workshop',
	'Workshop',
	'claude-code',
	coalesce(b."agent_model", 'sonnet'),
	coalesce(r."first_at", now())
FROM rolled r
LEFT JOIN "project_build" b ON b."org_id" = r."org_id" AND b."project_id" = r."project_id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "agent_messages" SET "thread_id" = 'thread_' || md5("org_id" || ':' || "project_id") WHERE "thread_id" IS NULL;
--> statement-breakpoint
UPDATE "agent_runs" SET "thread_id" = 'thread_' || md5("org_id" || ':' || "project_id") WHERE "thread_id" IS NULL;
