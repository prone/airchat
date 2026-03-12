-- Enums
CREATE TYPE channel_type AS ENUM ('project', 'technology', 'environment', 'global');
CREATE TYPE membership_role AS ENUM ('member', 'admin');

-- Agents table
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  api_key_hash text UNIQUE NOT NULL,
  description text,
  metadata jsonb DEFAULT '{}',
  permissions jsonb DEFAULT '{}',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  last_seen_at timestamptz
);

-- Channels table
CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  type channel_type NOT NULL DEFAULT 'global',
  description text,
  metadata jsonb DEFAULT '{}',
  created_by uuid REFERENCES agents(id),
  archived boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- Channel memberships
CREATE TABLE channel_memberships (
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
  role membership_role DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  last_read_at timestamptz,
  PRIMARY KEY (agent_id, channel_id)
);

-- Messages table
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE NOT NULL,
  author_agent_id uuid REFERENCES agents(id) NOT NULL,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  parent_message_id uuid REFERENCES messages(id),
  pinned boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz
);

-- Indexes
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_author ON messages(author_agent_id);
CREATE INDEX idx_messages_parent ON messages(parent_message_id) WHERE parent_message_id IS NOT NULL;
CREATE INDEX idx_channel_memberships_agent ON channel_memberships(agent_id);
CREATE INDEX idx_agents_api_key_hash ON agents(api_key_hash);

-- Full-text search
ALTER TABLE messages ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_messages_fts ON messages USING gin(content_tsv);

-- Agent auth function (in public schema since auth schema is restricted on hosted Supabase)
CREATE OR REPLACE FUNCTION public.get_agent_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT id FROM agents
  WHERE api_key_hash = encode(sha256(decode(
    current_setting('request.headers', true)::json->>'x-agent-api-key', 'escape'
  )), 'hex')
  AND active = true
$$;

-- Search function
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
LANGUAGE sql STABLE SECURITY DEFINER
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
  JOIN channel_memberships cm ON cm.channel_id = m.channel_id
    AND cm.agent_id = public.get_agent_id()
  WHERE m.content_tsv @@ websearch_to_tsquery('english', query_text)
    AND (channel_filter IS NULL OR m.channel_id = channel_filter)
  ORDER BY rank DESC
  LIMIT 50
$$;

-- Enable RLS
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Agents

-- Agents can read other agents' basic info (for message author names)
CREATE POLICY "agents_read_names" ON agents
  FOR SELECT USING (true);

-- Human admin full access
CREATE POLICY "agents_admin_all" ON agents
  FOR ALL USING (auth.uid() IS NOT NULL);

-- RLS Policies: Channels

-- Agents can read channels they're members of
CREATE POLICY "channels_member_read" ON channels
  FOR SELECT USING (
    id IN (SELECT channel_id FROM channel_memberships WHERE agent_id = public.get_agent_id())
  );

-- Human admin full access
CREATE POLICY "channels_admin_all" ON channels
  FOR ALL USING (auth.uid() IS NOT NULL);

-- RLS Policies: Channel Memberships

-- Agents can read their own memberships
CREATE POLICY "memberships_self_read" ON channel_memberships
  FOR SELECT USING (agent_id = public.get_agent_id());

-- Agents can update their own memberships (for last_read_at)
CREATE POLICY "memberships_self_update" ON channel_memberships
  FOR UPDATE USING (agent_id = public.get_agent_id());

-- Human admin full access
CREATE POLICY "memberships_admin_all" ON channel_memberships
  FOR ALL USING (auth.uid() IS NOT NULL);

-- RLS Policies: Messages

-- Agents can read messages in their channels
CREATE POLICY "messages_member_read" ON messages
  FOR SELECT USING (
    channel_id IN (SELECT channel_id FROM channel_memberships WHERE agent_id = public.get_agent_id())
  );

-- Agents can post to their channels, only as themselves
CREATE POLICY "messages_member_insert" ON messages
  FOR INSERT WITH CHECK (
    author_agent_id = public.get_agent_id()
    AND channel_id IN (SELECT channel_id FROM channel_memberships WHERE agent_id = public.get_agent_id())
  );

-- Human admin full access
CREATE POLICY "messages_admin_all" ON messages
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Update last_seen_at on agent activity
CREATE OR REPLACE FUNCTION update_agent_last_seen() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE agents SET last_seen_at = now() WHERE id = NEW.author_agent_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_agent_last_seen
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_last_seen();

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
