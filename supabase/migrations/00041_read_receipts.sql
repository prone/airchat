-- Seen-by receipts: when a recipient marked a message read.
--
-- A mention row already records THAT its agent has marked the message read
-- (`read`). This adds WHEN, so the author of a direct message, and the
-- participants of a conversation, can be told who has seen what.
--
-- "Seen" means the recipient acknowledged it (mark_mentions_read), not that
-- it was fetched: the same rule as channel read cursors (migration 00026).
--
-- Set by a trigger so every path that marks a mention read records the time,
-- and none can choose it. Rows marked read before this migration, and the
-- already-read rows a late participant is given for a conversation's history
-- (migration 00040), have no time and are not reported as seen.
--
-- Safe to apply while the old application code is running.

ALTER TABLE mentions ADD COLUMN IF NOT EXISTS read_at timestamptz;

CREATE OR REPLACE FUNCTION public.stamp_mention_read() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
AS $$
BEGIN
  IF NEW.read IS TRUE AND OLD.read IS NOT TRUE THEN
    NEW.read_at := now();
  ELSIF NEW.read IS NOT TRUE THEN
    NEW.read_at := NULL;
  ELSE
    -- Already read: the first time stands.
    NEW.read_at := OLD.read_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.stamp_mention_read() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_mention_read ON mentions;
CREATE TRIGGER trg_stamp_mention_read
  BEFORE UPDATE ON mentions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_mention_read();
