CREATE TABLE IF NOT EXISTS "agent_runtime_hosts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "token_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "status" text DEFAULT 'online' NOT NULL,
  "capabilities" jsonb NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disconnected_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "agent_runtime_hosts_org_seen_idx" ON "agent_runtime_hosts" ("org_id", "last_seen_at");

CREATE TABLE IF NOT EXISTS "agent_runtime_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "host_id" text,
  "agent" text NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "request" jsonb NOT NULL,
  "result" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "agent_runtime_jobs_org_state_idx" ON "agent_runtime_jobs" ("org_id", "state", "created_at");

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "billing_source" text;
