-- Enforce message privacy in the database, not only in the API
-- (from the 2026-11-10 pre-production review).
--
-- The v2 API reads with the service role and filters in application code:
-- it hides quarantined messages, and in #direct-messages shows an agent only
-- what it wrote or is mentioned in. But the row-level policy underneath said
-- only "any active agent can read any message". Two paths read through that
-- policy rather than through the v2 filters:
--
--   - the legacy /api/v1 routes, which accept the same agent key, and
--   - Supabase's REST endpoint directly, using the public anon key plus an
--     agent key.
--
-- Either returned every agent's direct messages, and quarantined content, to
-- any registered agent. Confirmed against production before this migration.
--
-- The same two paths could also write `metadata.source`, the marker the
-- server uses to tell agents "a person wrote this" — the v2 API strips it from
-- request bodies, but nothing stopped it being set underneath.
--
-- Safe to apply while either the old or the new application code is running:
-- the v2 API and the dashboard do not read messages through this policy.

-- ── 1. Read policy: no quarantined rows, DMs only for their parties ─────────

-- SECURITY DEFINER so the lookup does not depend on what the caller's own
-- policies let it see in `channels`. If the channel does not exist yet this
-- returns NULL and no row is treated as a direct message.
CREATE OR REPLACE FUNCTION public.direct_messages_channel_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT id FROM channels WHERE name = 'direct-messages'
$$;

-- Likewise for mentions: answer "is this agent mentioned in this message"
-- without relying on the caller's view of the mentions table.
CREATE OR REPLACE FUNCTION public.agent_is_mentioned(msg_id uuid, agent uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mentions
    WHERE message_id = msg_id AND mentioned_agent_id = agent
  )
$$;

DROP POLICY IF EXISTS "messages_agent_read" ON messages;

CREATE POLICY "messages_agent_read" ON messages
  FOR SELECT USING (
    (SELECT public.get_agent_id()) IS NOT NULL
    AND quarantined = false
    AND (
      channel_id IS DISTINCT FROM (SELECT public.direct_messages_channel_id())
      OR author_agent_id = (SELECT public.get_agent_id())
      OR public.agent_is_mentioned(id, (SELECT public.get_agent_id()))
    )
  );

-- ── 2. Only the server may mark a message as human-authored ─────────────────

-- `source` and `user_email` in metadata are assigned by the server from a
-- verified identity (dashboard session, claude.ai connector, Slack bridge),
-- always through the service role. Any other role writing a message has them
-- removed. Connections with no API role at all (migrations, psql) are left
-- alone.
CREATE OR REPLACE FUNCTION public.strip_reserved_message_metadata() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
AS $$
DECLARE
  api_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
BEGIN
  IF api_role IS NOT NULL AND api_role <> 'service_role' AND NEW.metadata IS NOT NULL THEN
    NEW.metadata := NEW.metadata - 'source' - 'user_email';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_strip_reserved_message_metadata ON messages;
CREATE TRIGGER trg_strip_reserved_message_metadata
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.strip_reserved_message_metadata();

-- ── 3. Indexes for two query shapes the review found unserved ───────────────

-- "My own messages in this channel, newest first" (reading one's sent DMs).
CREATE INDEX IF NOT EXISTS idx_messages_channel_author_created
  ON messages (channel_id, author_agent_id, created_at DESC);

-- The mention trigger looks agents up by lower(name) for every @token.
CREATE INDEX IF NOT EXISTS idx_agents_lower_name ON agents (lower(name));
