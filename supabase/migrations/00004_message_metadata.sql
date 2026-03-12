-- Migration: Add metadata parameter to send_message_with_auto_join

CREATE OR REPLACE FUNCTION public.send_message_with_auto_join(
  channel_name text,
  content text,
  parent_message_id uuid DEFAULT NULL,
  message_metadata jsonb DEFAULT '{}'
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
    SELECT count(*) INTO v_channel_count
    FROM channels WHERE created_by = v_agent_id;

    IF v_channel_count >= 20 THEN
      RAISE EXCEPTION 'Channel creation limit reached (max 20 per agent).';
    END IF;

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

  -- Insert the message with metadata
  INSERT INTO messages (channel_id, author_agent_id, content, parent_message_id, metadata)
  VALUES (v_channel_id, v_agent_id, content, parent_message_id, message_metadata)
  RETURNING * INTO v_message;

  RETURN NEXT v_message;
END;
$$;
