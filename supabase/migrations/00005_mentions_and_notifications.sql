-- Migration: Mentions table, auto-extract trigger, and check_mentions RPC

-- Mentions table: tracks @agent-name references in messages
CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE NOT NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  mentioned_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
  mentioning_agent_id uuid REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_mentions_agent_unread ON mentions(mentioned_agent_id, read) WHERE read = false;
CREATE INDEX idx_mentions_message ON mentions(message_id);

-- Enable RLS
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;

-- Agents can read their own mentions
CREATE POLICY "mentions_self_read" ON mentions
  FOR SELECT USING (mentioned_agent_id = public.get_agent_id());

-- Agents can update (mark read) their own mentions
CREATE POLICY "mentions_self_update" ON mentions
  FOR UPDATE USING (mentioned_agent_id = public.get_agent_id());

-- Human admin full access
CREATE POLICY "mentions_admin_all" ON mentions
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Trigger function: extract @agent-name patterns from message content and create mentions
CREATE OR REPLACE FUNCTION extract_mentions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  mention_match text;
  mentioned_id uuid;
BEGIN
  -- Find all @agent-name patterns (alphanumeric, hyphens, underscores)
  FOR mention_match IN
    SELECT (regexp_matches(NEW.content, '@([a-zA-Z0-9_-]+)', 'g'))[1]
  LOOP
    -- Look up agent by name (case-insensitive)
    SELECT id INTO mentioned_id FROM agents
      WHERE lower(name) = lower(mention_match) AND active = true;

    -- Don't create self-mentions
    IF mentioned_id IS NOT NULL AND mentioned_id != NEW.author_agent_id THEN
      INSERT INTO mentions (message_id, channel_id, mentioned_agent_id, mentioning_agent_id)
      VALUES (NEW.id, NEW.channel_id, mentioned_id, NEW.author_agent_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_extract_mentions
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION extract_mentions();

-- RPC: Check pending mentions for the calling agent
CREATE OR REPLACE FUNCTION check_mentions(
  only_unread boolean DEFAULT true,
  mention_limit int DEFAULT 20
)
RETURNS TABLE (
  mention_id uuid,
  message_id uuid,
  channel_name text,
  author_name text,
  author_project text,
  content text,
  created_at timestamptz,
  is_read boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    mn.id AS mention_id,
    mn.message_id,
    c.name AS channel_name,
    a.name AS author_name,
    m.metadata->>'project' AS author_project,
    m.content,
    mn.created_at,
    mn.read AS is_read
  FROM mentions mn
  JOIN messages m ON m.id = mn.message_id
  JOIN channels c ON c.id = mn.channel_id
  JOIN agents a ON a.id = mn.mentioning_agent_id
  WHERE mn.mentioned_agent_id = public.get_agent_id()
    AND (NOT only_unread OR mn.read = false)
  ORDER BY mn.created_at DESC
  LIMIT mention_limit
$$;

-- RPC: Mark mentions as read
CREATE OR REPLACE FUNCTION mark_mentions_read(mention_ids uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE mentions
  SET read = true
  WHERE id = ANY(mention_ids)
    AND mentioned_agent_id = public.get_agent_id();
END;
$$;

-- Enable realtime for mentions
ALTER PUBLICATION supabase_realtime ADD TABLE mentions;
