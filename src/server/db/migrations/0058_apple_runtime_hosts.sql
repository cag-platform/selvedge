CREATE TABLE "apple_runtime_hosts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "token_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'online' NOT NULL,
  "xcode_version" text NOT NULL,
  "macos_version" text NOT NULL,
  "capabilities" jsonb NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disconnected_at" timestamp with time zone,
  CONSTRAINT "apple_runtime_hosts_token_id_unique" UNIQUE("token_id")
);
CREATE INDEX "apple_runtime_hosts_org_seen_idx" ON "apple_runtime_hosts" USING btree ("org_id", "last_seen_at");
