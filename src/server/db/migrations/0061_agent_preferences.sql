ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "preferred_agents" jsonb;
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "agent_preferences_set_at" timestamp with time zone;
ALTER TABLE "project_build" ADD COLUMN IF NOT EXISTS "builder_sessions" jsonb NOT NULL DEFAULT '{}'::jsonb;
