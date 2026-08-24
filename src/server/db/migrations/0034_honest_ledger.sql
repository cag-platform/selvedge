-- THE 111 WRONG ALL-CLEARS THAT WEREN'T — removing the record of them.
--
-- The honesty-ledger tripwire counted two event types as proof a prior
-- "users are fine" had been wrong when neither means users are affected:
-- deploy.failed_previous_serving means the previous version is STILL SERVING
-- (its own narration says "users are fine"), and data.migration_failed
-- narrates as cannot_tell — not knowing is not proof of a miss. Every routine
-- failed deploy within a day of an all-clear wrote a false confession, until
-- one account showed 111 "wrong all-clears" against zero ships and the whole
-- ledger read as noise.
--
-- The tripwire is fixed in code (src/server/trust/tripwire.ts, with a
-- structural test tying set membership to the templates). This removes the
-- incidents the bug wrote. It can identify them because the old detail line
-- interpolated the raw event type verbatim — the same wording bug that made
-- these unreadable makes them findable — and the new wording never contains
-- an event type, so this can never eat a row written after the fix.
--
-- Incidents from events that genuinely mean users are affected are untouched:
-- those misses were real, and deleting a real confession would be the exact
-- sin this ledger exists to prevent.
DELETE FROM trust_incidents
WHERE kind = 'false_all_clear'
  AND (
    detail LIKE '%deploy.failed_previous_serving%'
    OR detail LIKE '%data.migration_failed%'
    OR detail LIKE '%data.integrity_signal%'
  );
