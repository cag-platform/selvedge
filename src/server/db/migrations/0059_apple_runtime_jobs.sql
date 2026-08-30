CREATE TABLE "apple_runtime_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "project_id" text,
  "host_id" text,
  "kind" text NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "request" jsonb NOT NULL,
  "result" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "claimed_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
CREATE INDEX "apple_runtime_jobs_org_state_idx" ON "apple_runtime_jobs" USING btree ("org_id", "state", "created_at");
