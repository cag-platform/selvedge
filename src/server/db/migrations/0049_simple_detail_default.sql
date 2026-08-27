ALTER TABLE "orgs" ALTER COLUMN "technical_detail" SET DEFAULT 'simple';
--> statement-breakpoint
-- This is presentation state only. All run evidence, commands, paths, costs,
-- capsule receipts, and verification records remain stored and Full remains
-- available at the account or conversation level.
UPDATE "orgs" SET "technical_detail" = 'simple' WHERE "technical_detail" = 'full';
