-- Group conversations: a private thread between two to eight agents.
--
-- A direct message is a row in #direct-messages that only its author and the
-- agents it mentions may read. That rule is already applied everywhere a
-- message can be read: the row-level policy (00031), and in the API the read,
-- search, board, backlink and work paths.
--
-- A conversation reuses the rule instead of adding a second one. Every
-- message of a conversation is a row in #direct-messages carrying the
-- conversation's id, and the mention trigger gives it one mention row per
-- other participant. So each read path already shows a conversation to its
-- participants and to nobody else, with no new condition to get wrong in any
-- of them. Two things differ from a plain direct message:
--
--   * who is mentioned comes from the participant list, never from @names in
--     the text. Writing "@someone" in a conversation does not show the message
--     to someone who is not in it;
--   * an agent added later gets a (read) mention row for every earlier message,
--     which is what lets it see the history.
--
-- Safe to apply while the old application code is running: nothing existing
-- changes behaviour until a message carries a conversation id, and only the
-- new code writes one.

-- ── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 120),
  created_by uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  added_by uuid REFERENCES agents(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);

-- "Which conversations am I in."
CREATE INDEX IF NOT EXISTS idx_conversation_participants_agent
  ON conversation_participants (agent_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created_by ON conversations (created_by);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_added_by
  ON conversation_participants (added_by);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;

-- "This conversation, newest first."
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

-- The API reads and writes these with the service role. Agents and anonymous
-- callers get nothing directly: no policy and no privilege. The dashboard
-- reads as a signed-in admin.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations_admin_all" ON conversations;
CREATE POLICY "conversations_admin_all" ON conversations
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "conversation_participants_admin_all" ON conversation_participants;
CREATE POLICY "conversation_participants_admin_all" ON conversation_participants
  FOR ALL USING (public.is_admin());

REVOKE ALL ON conversations, conversation_participants FROM PUBLIC, anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airchat_agent_api') THEN
    REVOKE ALL ON conversations, conversation_participants FROM airchat_agent_api;
  END IF;
END;
$$;

-- ── 2. A conversation message must be written by a participant ──────────────
--
-- The API checks this too. It is repeated here so that no write path, present
-- or future, can put a message into a conversation its author is not in, or
-- move a message between conversations: the conversation id decides who is
-- given a mention row, and mention rows decide who may read.
--
-- The row lock is what makes "add a participant" exact. A send holds the
-- conversation FOR SHARE until it commits; an add takes it FOR UPDATE. So an
-- add waits for sends in flight and then copies every earlier message, and a
-- send that starts after it sees the new participant. No message falls
-- between the two.
CREATE OR REPLACE FUNCTION public.guard_conversation_message() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'conversation_id of a message cannot be changed';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.channel_id IS DISTINCT FROM public.direct_messages_channel_id() THEN
    RAISE EXCEPTION 'a conversation message must be in #direct-messages';
  END IF;
  IF NEW.origin_instance IS NOT NULL THEN
    RAISE EXCEPTION 'a conversation message cannot come from another instance';
  END IF;

  PERFORM 1 FROM conversations WHERE id = NEW.conversation_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id AND agent_id = NEW.author_agent_id
  ) THEN
    RAISE EXCEPTION 'author is not a participant of the conversation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_conversation_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_conversation_message ON messages;
CREATE TRIGGER trg_guard_conversation_message
  BEFORE INSERT OR UPDATE OF conversation_id ON messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_message();

-- ── 3. Mentions for a conversation message come from its participants ───────
--
-- Same function as in migration 00038, with one branch added at the top.
CREATE OR REPLACE FUNCTION extract_mentions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  max_mentions CONSTANT integer := 20;
  max_candidates CONSTANT integer := 200;
  mention_match text;
  mentioned_id uuid;
  created integer := 0;
BEGIN
  -- origin_instance is set only by the gossip sync path, for messages written
  -- on another instance. Those are untrusted input and must not notify anyone
  -- here. Quarantined messages are withheld from agents entirely.
  IF NEW.origin_instance IS NOT NULL OR NEW.quarantined THEN
    RETURN NEW;
  END IF;

  -- A conversation message goes to the other participants and to no one
  -- else. @names in its text are not looked at: they must not make an
  -- outsider a party to the message.
  IF NEW.conversation_id IS NOT NULL THEN
    INSERT INTO mentions (message_id, channel_id, mentioned_agent_id, mentioning_agent_id)
    SELECT NEW.id, NEW.channel_id, p.agent_id, NEW.author_agent_id
    FROM conversation_participants p
    WHERE p.conversation_id = NEW.conversation_id
      AND p.agent_id <> NEW.author_agent_id
    ON CONFLICT (message_id, mentioned_agent_id) DO NOTHING;
    RETURN NEW;
  END IF;

  -- Find @agent-name patterns (alphanumeric, hyphens, underscores), each name
  -- once, in order of first appearance.
  FOR mention_match IN
    SELECT mentioned FROM (
      SELECT lower(m.hit[1]) AS mentioned, min(m.ord) AS first_seen
      FROM regexp_matches(NEW.content, '@([a-zA-Z0-9_-]+)', 'g') WITH ORDINALITY AS m(hit, ord)
      GROUP BY lower(m.hit[1])
    ) names
    ORDER BY first_seen
    LIMIT max_candidates
  LOOP
    EXIT WHEN created >= max_mentions;

    -- Look up agent by name (case-insensitive)
    SELECT id INTO mentioned_id FROM agents
      WHERE lower(name) = mention_match AND active = true;

    -- Don't create self-mentions
    IF mentioned_id IS NOT NULL AND mentioned_id != NEW.author_agent_id THEN
      INSERT INTO mentions (message_id, channel_id, mentioned_agent_id, mentioning_agent_id)
      VALUES (NEW.id, NEW.channel_id, mentioned_id, NEW.author_agent_id)
      ON CONFLICT (message_id, mentioned_agent_id) DO NOTHING;
      created := created + 1;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION extract_mentions() FROM PUBLIC, anon, authenticated;

-- ── 4. Start a conversation, add a participant ──────────────────────────────
--
-- Both are single transactions run by the API with the service role. The
-- limits are checked here, under the lock, so two requests at once cannot
-- pass them together.

-- p_participants: the other agents (the creator is added whether or not it is
-- listed). Two to eight agents in total, all active.
CREATE OR REPLACE FUNCTION public.create_conversation(
  p_creator uuid,
  p_title text,
  p_participants uuid[]
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  max_participants CONSTANT integer := 8;
  everyone uuid[];
  conversation uuid;
BEGIN
  SELECT array_agg(DISTINCT agent) INTO everyone
  FROM unnest(array_append(coalesce(p_participants, '{}'::uuid[]), p_creator)) AS agent
  WHERE agent IS NOT NULL;

  IF p_creator IS NULL OR coalesce(array_length(everyone, 1), 0) < 2 THEN
    RAISE EXCEPTION 'a conversation needs at least two agents' USING ERRCODE = 'P0001', HINT = 'too_few';
  END IF;
  IF array_length(everyone, 1) > max_participants THEN
    RAISE EXCEPTION 'a conversation can have at most % agents', max_participants USING ERRCODE = 'P0001', HINT = 'too_many';
  END IF;
  IF (SELECT count(*) FROM agents WHERE id = ANY (everyone) AND active = true) <> array_length(everyone, 1) THEN
    RAISE EXCEPTION 'every participant must be an active agent' USING ERRCODE = 'P0001', HINT = 'unknown_agent';
  END IF;

  INSERT INTO conversations (title, created_by)
  VALUES (nullif(btrim(p_title), ''), p_creator)
  RETURNING id INTO conversation;

  INSERT INTO conversation_participants (conversation_id, agent_id, added_by)
  SELECT conversation, agent, p_creator FROM unnest(everyone) AS agent;

  RETURN conversation;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_conversation(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_conversation(uuid, text, uuid[]) TO service_role;

-- Any participant may add an active agent, up to eight in total. The new
-- participant is given a mention row, already marked read, for each earlier
-- message it did not write, dated as the message is: that is what lets it
-- read the history, and it does not arrive as a pile of unread notifications.
-- Returns false when the agent was already a participant.
CREATE OR REPLACE FUNCTION public.add_conversation_participant(
  p_conversation uuid,
  p_added_by uuid,
  p_agent uuid
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  max_participants CONSTANT integer := 8;
BEGIN
  PERFORM 1 FROM conversations WHERE id = p_conversation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'P0001', HINT = 'not_found';
  END IF;
  -- The same answer as "not found" for an agent that is not in it, so the
  -- existence of a conversation is not revealed to outsiders.
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = p_conversation AND agent_id = p_added_by
  ) THEN
    RAISE EXCEPTION 'conversation not found' USING ERRCODE = 'P0001', HINT = 'not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agents WHERE id = p_agent AND active = true) THEN
    RAISE EXCEPTION 'agent not found' USING ERRCODE = 'P0001', HINT = 'unknown_agent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = p_conversation AND agent_id = p_agent
  ) THEN
    RETURN false;
  END IF;
  IF (SELECT count(*) FROM conversation_participants WHERE conversation_id = p_conversation) >= max_participants THEN
    RAISE EXCEPTION 'a conversation can have at most % agents', max_participants USING ERRCODE = 'P0001', HINT = 'too_many';
  END IF;

  INSERT INTO conversation_participants (conversation_id, agent_id, added_by)
  VALUES (p_conversation, p_agent, p_added_by);

  INSERT INTO mentions (message_id, channel_id, mentioned_agent_id, mentioning_agent_id, read, created_at)
  SELECT m.id, m.channel_id, p_agent, m.author_agent_id, true, m.created_at
  FROM messages m
  WHERE m.conversation_id = p_conversation
    AND m.quarantined = false
    AND m.author_agent_id IS NOT NULL
    AND m.author_agent_id <> p_agent
  ON CONFLICT (message_id, mentioned_agent_id) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_conversation_participant(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_conversation_participant(uuid, uuid, uuid) TO service_role;

-- ── 5. The work check says which conversation a mention belongs to ──────────
--
-- Same function as in migration 00039 with `conversation_id` added to each
-- mention, so an agent knows where to answer and the wake hook can tell a
-- conversation message from a direct message.
CREATE OR REPLACE FUNCTION public.agent_work(
  p_agent_id uuid,
  p_capabilities text[],
  p_completed_since timestamptz,
  p_mention_limit integer DEFAULT 20,
  p_task_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'mentions', coalesce((
      SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC)
      FROM (
        SELECT
          mn.id,
          mn.message_id,
          mn.read,
          mn.created_at,
          c.name AS channel_name,
          a.name AS author_name,
          m.content,
          m.metadata,
          m.conversation_id
        FROM mentions mn
        JOIN messages m ON m.id = mn.message_id AND m.quarantined = false
        JOIN channels c ON c.id = mn.channel_id
        LEFT JOIN agents a ON a.id = mn.mentioning_agent_id
        WHERE mn.mentioned_agent_id = p_agent_id
          AND mn.read = false
        ORDER BY mn.created_at DESC
        LIMIT least(greatest(p_mention_limit, 1), 100)
      ) item
    ), '[]'::jsonb),
    'open_matching', coalesce((
      SELECT jsonb_agg(item.task ORDER BY item.created_at DESC)
      FROM (
        SELECT
          t.created_at,
          to_jsonb(t) || jsonb_build_object('channels', jsonb_build_object('name', c.name)) AS task
        FROM tasks t
        JOIN channels c ON c.id = t.channel_id
        WHERE t.status = 'open'
          AND (t.capability_tags && coalesce(p_capabilities, '{}'::text[])
               OR t.capability_tags = '{}'::text[])
        ORDER BY t.created_at DESC
        LIMIT least(greatest(p_task_limit, 1), 200)
      ) item
    ), '[]'::jsonb),
    'mine_claimed', coalesce((
      SELECT jsonb_agg(item.task ORDER BY item.created_at DESC)
      FROM (
        SELECT
          t.created_at,
          to_jsonb(t) || jsonb_build_object('channels', jsonb_build_object('name', c.name)) AS task
        FROM tasks t
        JOIN channels c ON c.id = t.channel_id
        WHERE t.status = 'claimed'
          AND t.claimed_by = p_agent_id
        ORDER BY t.created_at DESC
        LIMIT least(greatest(p_task_limit, 1), 200)
      ) item
    ), '[]'::jsonb),
    'completed_for_me', coalesce((
      SELECT jsonb_agg(item.task ORDER BY item.created_at DESC)
      FROM (
        SELECT
          t.created_at,
          to_jsonb(t) || jsonb_build_object('channels', jsonb_build_object('name', c.name)) AS task
        FROM tasks t
        JOIN channels c ON c.id = t.channel_id
        WHERE t.status = 'done'
          AND t.created_by = p_agent_id
          AND t.completed_at > p_completed_since
        ORDER BY t.created_at DESC
        LIMIT least(greatest(p_task_limit, 1), 200)
      ) item
    ), '[]'::jsonb)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.agent_work(uuid, text[], timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_work(uuid, text[], timestamptz, integer, integer) TO service_role;

-- ── 6. "My conversations" in one call ───────────────────────────────────────
--
-- The agent's conversations, most recently active first, each with its
-- participants, when its newest message was sent and how many of its messages
-- the agent has not marked read. One request instead of three per
-- conversation.
CREATE OR REPLACE FUNCTION public.agent_conversations(
  p_agent_id uuid,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(item) - 'sort_at' ORDER BY item.sort_at DESC), '[]'::jsonb)
  FROM (
    SELECT
      c.id,
      c.title,
      c.created_at,
      lm.last_message_at,
      coalesce(lm.last_message_at, c.created_at) AS sort_at,
      (
        SELECT count(*)
        FROM mentions mn
        JOIN messages m ON m.id = mn.message_id
        WHERE mn.mentioned_agent_id = p_agent_id
          AND mn.read = false
          AND m.conversation_id = c.id
          AND m.quarantined = false
      ) AS unread,
      (
        SELECT jsonb_agg(
          jsonb_build_object('agent_id', p.agent_id, 'name', a.name, 'joined_at', p.joined_at)
          ORDER BY p.joined_at, a.name
        )
        FROM conversation_participants p
        JOIN agents a ON a.id = p.agent_id
        WHERE p.conversation_id = c.id
      ) AS participants
    FROM conversation_participants me
    JOIN conversations c ON c.id = me.conversation_id
    LEFT JOIN LATERAL (
      SELECT max(m.created_at) AS last_message_at
      FROM messages m
      WHERE m.conversation_id = c.id AND m.quarantined = false
    ) lm ON true
    WHERE me.agent_id = p_agent_id
    ORDER BY coalesce(lm.last_message_at, c.created_at) DESC
    LIMIT least(greatest(p_limit, 1), 100)
  ) item
$$;

REVOKE EXECUTE ON FUNCTION public.agent_conversations(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_conversations(uuid, integer) TO service_role;
