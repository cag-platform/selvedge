-- Search inside a project: the indexes that keep it honest at size.
--
-- The timeline itself needs no new storage — it is a projection of cards, runs,
-- narrations and threads, all of which are already indexed by (org_id,
-- project_id). What DOES need help is search, which reads the text columns.
--
-- Full-text indexes, because the search runs full-text and containment
-- together: full-text catches word forms ("shipping" finds "shipped"),
-- containment catches the half-words people actually type. Containment can't
-- use these indexes, and at this scale it doesn't need to — one project's
-- messages are thousands of rows, not millions. When that stops being true the
-- fix is a trigram index here, and no caller changes.
CREATE INDEX IF NOT EXISTS "agent_messages_search_idx" ON "agent_messages" USING GIN (to_tsvector('english', "content"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cards_title_search_idx" ON "cards" USING GIN (to_tsvector('english', "title"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cards_proposal_search_idx" ON "cards" USING GIN (to_tsvector('english', "proposal"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "narrations_fragment_search_idx" ON "narrations" USING GIN (to_tsvector('english', coalesce("fragment", '')));
