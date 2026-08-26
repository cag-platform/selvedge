ALTER TABLE "distribution_signals" ADD COLUMN "classification" jsonb;
ALTER TABLE "distribution_signals" ADD COLUMN "processed_at" timestamp with time zone;
ALTER TABLE "distribution_opportunities" ADD COLUMN "actionability_score" integer DEFAULT 0 NOT NULL;
ALTER TABLE "distribution_opportunities" ADD COLUMN "risk_score" integer DEFAULT 0 NOT NULL;
ALTER TABLE "distribution_opportunities" ADD COLUMN "can_help_without_pitching" boolean DEFAULT false NOT NULL;
ALTER TABLE "distribution_opportunities" ADD COLUMN "product_mention_appropriate" boolean DEFAULT false NOT NULL;
ALTER TABLE "distribution_opportunities" ADD COLUMN "scoring_version" text DEFAULT 'v1' NOT NULL;
