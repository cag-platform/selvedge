-- What was bought, and what it has been used for.
--
-- Org-scoped, like everything else here. The brief this came from specified a
-- Clerk user id; every other table in this database keys on org_id, a solo
-- owner is already the only member of an org, and the Team tier can have no
-- other shape. The user who paid is recorded as attribution, not tenancy.
--
-- Note there are now two columns called "plan" and they are different axes.
-- orgs.plan ('trial' | 'care' | 'studio') decides how much of SELVEDGE'S own
-- model budget an org may spend per day. subscriptions.plan ('free' | 'pro' |
-- 'team') decides what the CUSTOMER bought. Nothing derives one from the other.

-- Absent means free. An org that signed up thirty seconds ago and an org whose
-- webhook is still in flight both read as free and both work — a missing row is
-- the normal case, not an error.
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "bought_by_user_id" text,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "plan" text DEFAULT 'free' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "billing_interval" text,
  "grandfathered_price" boolean DEFAULT false NOT NULL,
  "current_period_end" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_org_idx" ON "subscriptions" ("org_id");
--> statement-breakpoint
-- Webhooks arrive keyed on the customer, sometimes before the app has seen the
-- owner again, so the upsert path has to be able to find a row by this alone.
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_customer_idx" ON "subscriptions" ("stripe_customer_id");
--> statement-breakpoint

-- Build minutes used, per org, per calendar month. period_start is the first of
-- the month in UTC and is computed server-side: a window a client computes is a
-- quota that changes with the traveller's timezone.
--
-- Whole minutes, because every run rounds its wall-clock seconds up to a minute
-- when it meters. A fractional column would imply we track something finer than
-- we do.
CREATE TABLE IF NOT EXISTS "usage_build_minutes" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "minutes_used" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_build_minutes_org_period_idx" ON "usage_build_minutes" ("org_id","period_start");
--> statement-breakpoint

-- One row per sandbox we ever start, whether or not anything came of it.
--
-- Daytona bills wall-clock time, so wall-clock time is what this records: from
-- creation to confirmed stop. The row exists so that two things stay true — we
-- never lose track of a sandbox we started (the reaper reads this table, not
-- Daytona's), and a sandbox that cost money always lands in the meter,
-- including the ones that ended badly.
CREATE TABLE IF NOT EXISTS "sandbox_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "daytona_sandbox_id" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  -- Refreshed by anything that proves the sandbox was alive. When a stop
  -- confirmation never arrives, this is the honest end time for a run we can no
  -- longer ask about: guessing later would overcharge, guessing started_at
  -- would hide money we actually spent.
  "last_alive_at" timestamp with time zone DEFAULT now() NOT NULL,
  "wall_clock_seconds" integer,
  "end_reason" text,
  -- Set once, guarded, so a double stop meters exactly once.
  "metered" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_runs_org_idx" ON "sandbox_runs" ("org_id","started_at");
--> statement-breakpoint
-- The reaper's query: everything still open, cheaply.
CREATE INDEX IF NOT EXISTS "sandbox_runs_open_idx" ON "sandbox_runs" ("ended_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_runs_sandbox_idx" ON "sandbox_runs" ("daytona_sandbox_id");
--> statement-breakpoint

-- Stripe event ids we have already applied. Stripe retries, and a retry that
-- re-applies a handler is how a cancelled subscription comes back to life.
CREATE TABLE IF NOT EXISTS "stripe_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
