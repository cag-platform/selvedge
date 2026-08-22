-- Sources the owner has told Selvedge to stop asking about.
--
-- The unsorted tray asks "where does this belong?" and the honest set of
-- answers is three, not one: it's a project I already have, it's a project I
-- don't have yet, or it isn't mine to care about. Only the first existed, so
-- anything in the third case sat in the tray forever and the tray stopped
-- meaning anything.
--
-- Ignoring is a row, not a flag on the events, for two reasons. It has to
-- cover events that HAVEN'T ARRIVED YET — otherwise tomorrow's push from a
-- repo you dismissed is back in the tray, which is exactly the "it asked me
-- twice" failure. And it has to be undoable without guessing which events
-- were once dismissed: deleting the row restores them all.
CREATE TABLE IF NOT EXISTS "ignored_sources" (
  "org_id" text NOT NULL,
  "connector" text NOT NULL,
  "resource_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ignored_sources_pk" PRIMARY KEY ("org_id","connector","resource_id")
);
