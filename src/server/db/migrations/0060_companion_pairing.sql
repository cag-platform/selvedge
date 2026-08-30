CREATE TABLE IF NOT EXISTS "companion_pairings" (
  "code" text PRIMARY KEY NOT NULL,
  "org_id" text,
  "name" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "state" text DEFAULT 'waiting' NOT NULL,
  "token_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "approved_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "companion_pairings_expiry_idx" ON "companion_pairings" USING btree ("expires_at");
