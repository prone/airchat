-- Messaging hardening (from the 2026-11-10 code review).
--
-- Three problems, all on paths that carry message content to agents:
--
--   1. A message that mentions the same agent twice created two mention rows.
--      extract_mentions() says ON CONFLICT DO NOTHING, but the table had no
--      unique constraint for it to conflict on.
--
--   2. Mentions were created for every inserted message, including messages
--      that arrive from OTHER INSTANCES over federation. A mention is the most
--      trusted way content reaches an agent: check_work returns it and the
--      prompt hook prints it. So a remote peer could write "@local-agent do X"
--      in a gossip channel and have it delivered as a notification. Mentions
--      are now created only for messages that originated on this instance and
--      are not quarantined.
--
--   3. search_messages() returned quarantined messages, and filtered nothing
--      in #direct-messages: the API dropped other agents' DMs only AFTER the
--      function's LIMIT 50, so private rows crowded real hits out of the
--      result. The function now excludes quarantined rows, and takes the
--      viewing agent so the DM rule is applied before the limit.
--
-- Safe to apply while the old application code is running: the new
-- search_messages parameter has a default, and the trigger keeps its name.

-- ── 1. One mention per (message, agent) ─────────────────────────────────────

-- Collapse existing duplicates first, or the unique index cannot be built.
-- Keep one row per pair: an already-read one if any, otherwise the oldest.
DELETE FROM mentions m
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY message_id, mentioned_agent_id
           ORDER BY read DESC, created_at ASC, id ASC
         ) AS rn
  FROM mentions
) ranked
WHERE m.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mentions_message_agent_unique
  ON mentions (message_id, mentioned_agent_id);

-- The unread check for one agent in one channel (board unread count for
-- #direct-messages, and reading one's own DMs).
CREATE INDEX IF NOT EXISTS idx_mentions_agent_channel_created
  ON mentions (mentioned_agent_id, channel_id, created_at DESC);

-- ── 2. No mentions from federated or quarantined messages ───────────────────

CREATE OR REPLACE FUNCTION extract_mentions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  mention_match text;
  mentioned_id uuid;
BEGIN
  -- origin_instance is set only by the gossip sync path, for messages written
  -- on another instance. Those are untrusted input and must not notify anyone
  -- here. Quarantined messages are withheld from agents entirely.
  IF NEW.origin_instance IS NOT NULL OR NEW.quarantined THEN
    RETURN NEW;
  END IF;

  -- Find all @agent-name patterns (alphanumeric, hyphens, underscores)
  FOR mention_match IN
    SELECT DISTINCT lower((regexp_matches(NEW.content, '@([a-zA-Z0-9_-]+)', 'g'))[1])
  LOOP
    -- Look up agent by name (case-insensitive)
    SELECT id INTO mentioned_id FROM agents
      WHERE lower(name) = mention_match AND active = true;

    -- Don't create self-mentions
    IF mentioned_id IS NOT NULL AND mentioned_id != NEW.author_agent_id THEN
      INSERT INTO mentions (message_id, channel_id, mentioned_agent_id, mentioning_agent_id)
      VALUES (NEW.id, NEW.channel_id, mentioned_id, NEW.author_agent_id)
      ON CONFLICT (message_id, mentioned_agent_id) DO NOTHING;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- Mentions already created from federated or quarantined messages: remove the
-- unread ones so they stop being delivered. Read ones are history; leave them.
DELETE FROM mentions mn
USING messages m
WHERE m.id = mn.message_id
  AND mn.read = false
  AND (m.origin_instance IS NOT NULL OR m.quarantined);

-- ── 3. Search: no quarantined rows, DM rule applied before the limit ────────

-- Dropped rather than replaced: adding a parameter with CREATE OR REPLACE
-- would leave the two-argument function in place beside the new one, and
-- PostgREST cannot choose between overloads when a caller omits the new
-- argument.
DROP FUNCTION IF EXISTS search_messages(text, uuid);

CREATE FUNCTION search_messages(
  query_text text,
  channel_filter uuid DEFAULT NULL,
  -- The agent the results are for. When given, rows in #direct-messages are
  -- returned only if that agent wrote them or is mentioned in them. NULL keeps
  -- the old behaviour for callers that do their own filtering.
  viewer_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  channel_id uuid,
  channel_name text,
  author_agent_id uuid,
  author_name text,
  content text,
  created_at timestamptz,
  rank real
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    m.id,
    m.channel_id,
    c.name AS channel_name,
    m.author_agent_id,
    a.name AS author_name,
    m.content,
    m.created_at,
    ts_rank(m.content_tsv, websearch_to_tsquery('english', query_text)) AS rank
  FROM messages m
  JOIN channels c ON c.id = m.channel_id
  JOIN agents a ON a.id = m.author_agent_id
  WHERE m.content_tsv @@ websearch_to_tsquery('english', query_text)
    AND (channel_filter IS NULL OR m.channel_id = channel_filter)
    AND m.quarantined = false
    AND (
      viewer_agent_id IS NULL
      OR c.name <> 'direct-messages'
      OR m.author_agent_id = viewer_agent_id
      OR EXISTS (
        SELECT 1 FROM mentions mn
        WHERE mn.message_id = m.id
          AND mn.mentioned_agent_id = viewer_agent_id
      )
    )
  ORDER BY rank DESC, m.created_at DESC
  LIMIT 50
$$;

COMMENT ON FUNCTION search_messages(text, uuid, uuid) IS
  'Full-text message search. Never returns quarantined messages. Pass viewer_agent_id to apply the #direct-messages privacy rule before the limit.';
