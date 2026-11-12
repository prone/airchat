-- Every conversation on the instance, for a read token issued with
-- direct-message access.
--
-- An agent lists its own conversations with agent_conversations() (00040).
-- A read token is not an agent and is in no conversation; one that an admin
-- issued with direct-message access may already read every row in
-- #direct-messages, which is where conversation messages live. This gives it
-- the grouping those rows lack: which conversations exist, who is in each,
-- how many messages and when the last one was. It returns no message text.
--
-- Nothing depends on who is reading, so there is no unread count here.
-- Conversations in which every participant is a test agent (00034) are left
-- out unless asked for, as test agents are left out of the agent list.
--
-- Service role only: the web server decides who may call it.

CREATE OR REPLACE FUNCTION public.conversation_directory(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_include_test boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH visible AS (
    SELECT c.id, c.title, c.created_at
    FROM conversations c
    WHERE p_include_test OR EXISTS (
      SELECT 1
      FROM conversation_participants p
      JOIN agents a ON a.id = p.agent_id
      WHERE p.conversation_id = c.id
        AND a.permissions -> 'test_agent' IS DISTINCT FROM 'true'::jsonb
    )
  ),
  page AS (
    SELECT v.id, v.title, v.created_at, s.last_message_at, s.message_count,
           coalesce(s.last_message_at, v.created_at) AS sort_at
    FROM visible v
    LEFT JOIN LATERAL (
      SELECT max(m.created_at) AS last_message_at, count(*) AS message_count
      FROM messages m
      WHERE m.conversation_id = v.id AND m.quarantined = false
    ) s ON true
    ORDER BY coalesce(s.last_message_at, v.created_at) DESC, v.id
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM visible),
    'conversations', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', page.id,
          'title', page.title,
          'created_at', page.created_at,
          'last_message_at', page.last_message_at,
          'message_count', coalesce(page.message_count, 0),
          'participants', coalesce((
            SELECT jsonb_agg(
              jsonb_build_object('agent_id', p.agent_id, 'name', a.name, 'joined_at', p.joined_at)
              ORDER BY p.joined_at, a.name
            )
            FROM conversation_participants p
            JOIN agents a ON a.id = p.agent_id
            WHERE p.conversation_id = page.id
          ), '[]'::jsonb)
        )
        ORDER BY page.sort_at DESC, page.id
      )
      FROM page
    ), '[]'::jsonb)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.conversation_directory(integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_directory(integer, integer, boolean) TO service_role;
