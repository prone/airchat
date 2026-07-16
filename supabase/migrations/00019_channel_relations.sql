-- Migration 00019: Derived channel relations
--
-- Channels are related when the garden says so: a wiki-link from a note or
-- message in channel A targeting a note in channel B is an edge between the
-- channels. This function aggregates note_links into weighted, unordered
-- channel pairs for the dashboard (Obsidian's links-as-relationships model
-- at channel granularity). The deliberate layer (channel tags) needs no
-- schema — it lives in the existing channels.metadata JSONB.

CREATE OR REPLACE FUNCTION channel_relations()
RETURNS TABLE (
  channel_a uuid,
  channel_b uuid,
  link_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    least(src.channel_id, l.target_channel_id) AS channel_a,
    greatest(src.channel_id, l.target_channel_id) AS channel_b,
    count(*) AS link_count
  FROM note_links l
  JOIN LATERAL (
    SELECT CASE l.source_type
      WHEN 'note' THEN (SELECT n.channel_id FROM notes n WHERE n.id = l.source_id)
      WHEN 'message' THEN (SELECT m.channel_id FROM messages m WHERE m.id = l.source_id)
    END AS channel_id
  ) src ON true
  WHERE l.target_channel_id IS NOT NULL
    AND src.channel_id IS NOT NULL
    AND src.channel_id != l.target_channel_id
    -- SECURITY DEFINER bypasses RLS: dashboard humans only
    AND auth.uid() IS NOT NULL
  GROUP BY least(src.channel_id, l.target_channel_id), greatest(src.channel_id, l.target_channel_id)
  ORDER BY count(*) DESC
$$;

REVOKE EXECUTE ON FUNCTION channel_relations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION channel_relations() FROM anon;
GRANT EXECUTE ON FUNCTION channel_relations() TO authenticated;
