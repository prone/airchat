-- Migration: Security hardening
-- Fixes: api_key_hash exposure, admin role checks, membership role escalation,
-- input validation, channel creation limits

-- =============================================================================
-- 1. CRITICAL: Create a view to hide api_key_hash from agents table reads
-- =============================================================================

-- Drop the overly permissive policy that exposes api_key_hash to everyone
DROP POLICY IF EXISTS "agents_read_names" ON agents;

-- Replace with a policy that only exposes safe columns via a function
-- We use a SECURITY DEFINER function that returns only public agent info
CREATE OR REPLACE FUNCTION public.get_agents_public()
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  active boolean,
  created_at timestamptz,
  last_seen_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, name, description, active, created_at, last_seen_at FROM agents;
$$;

-- Agents and authenticated users can read agent info (excluding api_key_hash)
-- Only allow reading if the caller is an agent or an authenticated user
CREATE POLICY "agents_read_safe" ON agents
  FOR SELECT USING (
    public.get_agent_id() IS NOT NULL
    OR auth.uid() IS NOT NULL
  );

-- Revoke direct SELECT on api_key_hash from anon and authenticated roles
-- This prevents reading the hash even if the RLS policy allows the row
REVOKE ALL ON agents FROM anon;
REVOKE ALL ON agents FROM authenticated;

-- Grant SELECT on specific safe columns only
GRANT SELECT (id, name, description, active, metadata, created_at, last_seen_at) ON agents TO anon;
GRANT SELECT (id, name, description, active, metadata, permissions, created_at, last_seen_at) ON agents TO authenticated;

-- Authenticated users need INSERT/UPDATE/DELETE for admin operations
GRANT INSERT, UPDATE, DELETE ON agents TO authenticated;

-- =============================================================================
-- 2. HIGH: Restrict admin policies to actual admin users
-- =============================================================================

-- We use a helper function to check if the current user is an admin
-- For now, we check against a list stored in a simple table
-- This is more maintainable than hardcoding user IDs

CREATE TABLE IF NOT EXISTS admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Only admins can read the admin_users table
CREATE POLICY "admin_users_self_read" ON admin_users
  FOR SELECT USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_users WHERE user_id = auth.uid()
  );
$$;

-- Drop the old permissive admin policies
DROP POLICY IF EXISTS "agents_admin_all" ON agents;
DROP POLICY IF EXISTS "channels_admin_all" ON channels;
DROP POLICY IF EXISTS "memberships_admin_all" ON channel_memberships;
DROP POLICY IF EXISTS "messages_admin_all" ON messages;

-- Recreate with admin role check
CREATE POLICY "agents_admin_all" ON agents
  FOR ALL USING (public.is_admin());

CREATE POLICY "channels_admin_all" ON channels
  FOR ALL USING (public.is_admin());

CREATE POLICY "memberships_admin_all" ON channel_memberships
  FOR ALL USING (public.is_admin());

CREATE POLICY "messages_admin_all" ON messages
  FOR ALL USING (public.is_admin());

-- =============================================================================
-- 3. HIGH: Add input validation constraints
-- =============================================================================

-- Message content length limit (32KB)
ALTER TABLE messages ADD CONSTRAINT messages_content_length
  CHECK (length(content) <= 32000);

-- Channel name validation: lowercase alphanumeric, hyphens, 2-100 chars
ALTER TABLE channels ADD CONSTRAINT channels_name_format
  CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,99}$');

-- Agent name validation: similar pattern
ALTER TABLE agents ADD CONSTRAINT agents_name_format
  CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,99}$');

-- =============================================================================
-- 4. MEDIUM: Restrict membership self-update to last_read_at only
-- =============================================================================

-- Drop the overly permissive self-update policy
DROP POLICY IF EXISTS "memberships_self_update" ON channel_memberships;

-- Create a SECURITY DEFINER function that only updates last_read_at
CREATE OR REPLACE FUNCTION public.update_last_read(
  p_channel_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid;
BEGIN
  v_agent_id := public.get_agent_id();
  IF v_agent_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE channel_memberships
  SET last_read_at = now()
  WHERE agent_id = v_agent_id AND channel_id = p_channel_id;
END;
$$;

-- =============================================================================
-- 5. HIGH: Add validation to send_message_with_auto_join
-- =============================================================================

CREATE OR REPLACE FUNCTION public.send_message_with_auto_join(
  channel_name text,
  content text,
  parent_message_id uuid DEFAULT NULL
)
RETURNS SETOF messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid;
  v_channel_id uuid;
  v_channel_type channel_type;
  v_message messages;
  v_channel_count int;
BEGIN
  -- Get the calling agent's ID
  v_agent_id := public.get_agent_id();
  IF v_agent_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated as an active agent';
  END IF;

  -- Validate channel name
  IF channel_name !~ '^[a-z0-9][a-z0-9-]{1,99}$' THEN
    RAISE EXCEPTION 'Invalid channel name. Use lowercase alphanumeric and hyphens, 2-100 chars.';
  END IF;

  -- Validate content length
  IF length(content) > 32000 THEN
    RAISE EXCEPTION 'Message content exceeds maximum length of 32000 characters.';
  END IF;

  IF length(content) = 0 THEN
    RAISE EXCEPTION 'Message content cannot be empty.';
  END IF;

  -- Look up the channel by name
  SELECT id INTO v_channel_id FROM channels WHERE name = channel_name;

  -- If channel doesn't exist, create it (with rate limit check)
  IF v_channel_id IS NULL THEN
    -- Limit: an agent can create at most 20 channels
    SELECT count(*) INTO v_channel_count
    FROM channels WHERE created_by = v_agent_id;

    IF v_channel_count >= 20 THEN
      RAISE EXCEPTION 'Channel creation limit reached (max 20 per agent).';
    END IF;

    -- Determine channel type based on name prefix
    IF channel_name LIKE 'project-%' THEN
      v_channel_type := 'project';
    ELSIF channel_name LIKE 'tech-%' THEN
      v_channel_type := 'technology';
    ELSE
      v_channel_type := 'global';
    END IF;

    INSERT INTO channels (name, type, created_by)
    VALUES (channel_name, v_channel_type, v_agent_id)
    RETURNING id INTO v_channel_id;
  END IF;

  -- If agent isn't a member, add membership
  INSERT INTO channel_memberships (agent_id, channel_id)
  VALUES (v_agent_id, v_channel_id)
  ON CONFLICT (agent_id, channel_id) DO NOTHING;

  -- Insert the message
  INSERT INTO messages (channel_id, author_agent_id, content, parent_message_id)
  VALUES (v_channel_id, v_agent_id, content, parent_message_id)
  RETURNING * INTO v_message;

  RETURN NEXT v_message;
END;
$$;

-- =============================================================================
-- 6. LOW: Change search_messages to SECURITY INVOKER where possible
-- =============================================================================

-- Recreate search_messages without SECURITY DEFINER since open reads
-- already allow agents to read all messages
CREATE OR REPLACE FUNCTION search_messages(
  query_text text,
  channel_filter uuid DEFAULT NULL
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
  ORDER BY rank DESC
  LIMIT 50
$$;
