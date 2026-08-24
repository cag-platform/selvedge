-- NAME THE CONVERSATIONS THAT PREDATE AUTO-TITLING.
--
-- Threads name themselves from the first thing said in them now, but only at
-- the moment of that first message — so every thread that already had history
-- when the feature shipped keeps its default title forever. On a real account
-- that is an inbox reading "Workshop" twelve times over, which is exactly the
-- screen auto-titling exists to prevent.
--
-- This is the same rule as titleFromFirstMessage (src/server/threads/store.ts),
-- in SQL: the earliest owner message, whitespace collapsed, cut at 60 chars on
-- a word boundary when one lands past the halfway mark, trailing punctuation
-- dropped, an ellipsis when something was cut. Only default titles are touched
-- ('Workshop', 'New thread', the pre-rename 'thread', and empty) — a title a
-- person chose is theirs. A default-titled thread nobody ever spoke in keeps
-- its default: there is nothing truer to call it.

WITH firsts AS (
  SELECT DISTINCT ON (m.thread_id)
         m.thread_id,
         regexp_replace(btrim(m.content), '\s+', ' ', 'g') AS line
  FROM agent_messages m
  WHERE m.role = 'owner'
    AND m.thread_id IS NOT NULL
    AND btrim(m.content) <> ''
  ORDER BY m.thread_id, m.created_at ASC
),
titled AS (
  SELECT thread_id,
    CASE
      WHEN length(line) <= 60 THEN regexp_replace(line, '[\s,;:.\-—]+$', '')
      WHEN length(regexp_replace(left(line, 60), '\s+\S*$', '')) > 30
        THEN regexp_replace(regexp_replace(left(line, 60), '\s+\S*$', ''), '[\s,;:.\-—]+$', '') || '…'
      ELSE regexp_replace(left(line, 60), '[\s,;:.\-—]+$', '') || '…'
    END AS new_title
  FROM firsts
)
UPDATE threads t
SET title = titled.new_title
FROM titled
WHERE t.id = titled.thread_id
  AND btrim(t.title) IN ('Workshop', 'New thread', 'thread', '')
  AND titled.new_title <> '';
