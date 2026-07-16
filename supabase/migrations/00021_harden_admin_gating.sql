-- Migration 00021: Harden admin gating to is_admin() (security fix)
--
-- Migration 00003 established public.is_admin() as the admin gate, but several
-- later tables/functions (00014 gossip, 00016 notes, 00018–00020 dashboard)
-- regressed to `auth.uid() IS NOT NULL`. Because signup is open, ANY
-- self-registered + email-confirmed authenticated user (not in admin_users)
-- could read all notes (which distill message content), llm_usage, and every
-- dashboard aggregate. This tightens every such gate to public.is_admin().
--
-- Agent access is unaffected (it flows through get_agent_id() membership
-- policies and the service-role REST API, neither of which changes here).

-- ── Notes tables: admin_all policies → is_admin() ───────────────────────────

DROP POLICY IF EXISTS "notes_admin_all" ON notes;
CREATE POLICY "notes_admin_all" ON notes
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "note_revisions_admin_all" ON note_revisions;
CREATE POLICY "note_revisions_admin_all" ON note_revisions
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "note_links_admin_all" ON note_links;
CREATE POLICY "note_links_admin_all" ON note_links
  FOR ALL USING (public.is_admin());

-- ── llm_usage: admin read → is_admin() ──────────────────────────────────────

DROP POLICY IF EXISTS "llm_usage_admin_read" ON llm_usage;
CREATE POLICY "llm_usage_admin_read" ON llm_usage
  FOR SELECT USING (public.is_admin());

-- ── Gossip tables (00014): admin_all → is_admin() ───────────────────────────

DROP POLICY IF EXISTS "gossip_instance_config_admin_all" ON gossip_instance_config;
CREATE POLICY "gossip_instance_config_admin_all" ON gossip_instance_config
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "gossip_peers_admin_all" ON gossip_peers;
CREATE POLICY "gossip_peers_admin_all" ON gossip_peers
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "gossip_message_origins_admin_all" ON gossip_message_origins;
CREATE POLICY "gossip_message_origins_admin_all" ON gossip_message_origins
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "gossip_retractions_admin_all" ON gossip_retractions;
CREATE POLICY "gossip_retractions_admin_all" ON gossip_retractions
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "gossip_key_rotations_admin_all" ON gossip_key_rotations;
CREATE POLICY "gossip_key_rotations_admin_all" ON gossip_key_rotations
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "gossip_agent_quarantines_admin_all" ON gossip_agent_quarantines;
CREATE POLICY "gossip_agent_quarantines_admin_all" ON gossip_agent_quarantines
  FOR ALL USING (public.is_admin());

-- ── SECURITY DEFINER functions: replace auth.uid() guard with is_admin() ────

-- search_notes: agents by membership OR admins (was: OR auth.uid())
CREATE OR REPLACE FUNCTION search_notes(
  query_text text,
  channel_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid, slug text, channel_id uuid, channel_name text,
  title text, is_stub boolean, updated_at timestamptz, rank real
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    n.id, n.slug, n.channel_id, c.name AS channel_name,
    n.title, n.is_stub, n.updated_at,
    ts_rank(n.content_tsv, websearch_to_tsquery('english', query_text)) AS rank
  FROM notes n
  LEFT JOIN channels c ON c.id = n.channel_id
  WHERE n.content_tsv @@ websearch_to_tsquery('english', query_text)
    AND (channel_filter IS NULL OR n.channel_id = channel_filter)
    AND (public.get_agent_id() IS NOT NULL OR public.is_admin())
    AND (
      n.channel_id IS NULL
      OR n.channel_id IN (
        SELECT cm.channel_id FROM channel_memberships cm
        WHERE cm.agent_id = public.get_agent_id()
      )
    )
  ORDER BY rank DESC
  LIMIT 50
$$;

-- dashboard_overview: admins only
CREATE OR REPLACE FUNCTION dashboard_overview()
RETURNS TABLE (
  channel_id uuid, channel_name text, channel_type text, federation_scope text,
  message_count bigint, human_message_count bigint, last_message_at timestamptz,
  content_chars bigint, messages_by_day jsonb, note_count bigint, stub_count bigint,
  digest_count bigint, latest_digest_slug text, note_chars bigint,
  llm_input_tokens bigint, llm_output_tokens bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH msg AS (
    SELECT
      m.channel_id,
      count(*) AS message_count,
      count(*) FILTER (
        WHERE m.metadata->>'source' IN ('dashboard', 'slack')
           OR a.name = 'dashboard-admin'
      ) AS human_message_count,
      max(m.created_at) AS last_message_at,
      sum(char_length(m.content))::bigint AS content_chars
    FROM messages m
    LEFT JOIN agents a ON a.id = m.author_agent_id
    WHERE m.quarantined = false
    GROUP BY m.channel_id
  ),
  by_day AS (
    SELECT
      d.cid AS channel_id,
      jsonb_agg(jsonb_build_object('d', d.day, 'human', d.human, 'agent', d.agent) ORDER BY d.day) AS days
    FROM (
      SELECT
        m2.channel_id AS cid,
        date_trunc('day', m2.created_at)::date AS day,
        count(*) FILTER (
          WHERE m2.metadata->>'source' IN ('dashboard', 'slack')
             OR a2.name = 'dashboard-admin'
        ) AS human,
        count(*) FILTER (
          WHERE NOT (coalesce(m2.metadata->>'source', '') IN ('dashboard', 'slack')
                     OR a2.name = 'dashboard-admin')
        ) AS agent
      FROM messages m2
      LEFT JOIN agents a2 ON a2.id = m2.author_agent_id
      WHERE m2.created_at >= now() - interval '7 days'
        AND m2.quarantined = false
      GROUP BY m2.channel_id, date_trunc('day', m2.created_at)::date
    ) d
    GROUP BY d.cid
  ),
  nts AS (
    SELECT
      n.channel_id,
      count(*) FILTER (WHERE NOT n.is_stub) AS note_count,
      count(*) FILTER (WHERE n.is_stub) AS stub_count,
      count(*) FILTER (WHERE n.properties->>'kind' = 'daily-digest') AS digest_count,
      max(n.slug) FILTER (WHERE n.properties->>'kind' = 'daily-digest') AS latest_digest_slug,
      sum(char_length(n.body_md))::bigint AS note_chars
    FROM notes n
    GROUP BY n.channel_id
  ),
  usage AS (
    SELECT u.channel_id, sum(u.input_tokens)::bigint AS llm_input_tokens, sum(u.output_tokens)::bigint AS llm_output_tokens
    FROM llm_usage u GROUP BY u.channel_id
  )
  SELECT
    c.id, c.name, c.type::text, c.federation_scope,
    coalesce(msg.message_count, 0), coalesce(msg.human_message_count, 0), msg.last_message_at,
    coalesce(msg.content_chars, 0), coalesce(by_day.days, '[]'::jsonb),
    coalesce(nts.note_count, 0), coalesce(nts.stub_count, 0), coalesce(nts.digest_count, 0),
    nts.latest_digest_slug, coalesce(nts.note_chars, 0),
    coalesce(usage.llm_input_tokens, 0), coalesce(usage.llm_output_tokens, 0)
  FROM channels c
  LEFT JOIN msg ON msg.channel_id = c.id
  LEFT JOIN by_day ON by_day.channel_id = c.id
  LEFT JOIN nts ON nts.channel_id = c.id
  LEFT JOIN usage ON usage.channel_id = c.id
  WHERE c.archived = false
    AND public.is_admin()
  ORDER BY msg.last_message_at DESC NULLS LAST
$$;

-- channel_relations: admins only
CREATE OR REPLACE FUNCTION channel_relations()
RETURNS TABLE (channel_a uuid, channel_b uuid, link_count bigint)
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
    AND public.is_admin()
  GROUP BY least(src.channel_id, l.target_channel_id), greatest(src.channel_id, l.target_channel_id)
  ORDER BY count(*) DESC
$$;

-- channel_activity_timeline: admins only
CREATE OR REPLACE FUNCTION channel_activity_timeline(p_channel_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE (day date, message_count bigint, content_chars bigint, llm_input_tokens bigint, llm_output_tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - (greatest(p_days, 1) - 1) * interval '1 day')::date,
      current_date, interval '1 day'
    )::date AS day
  ),
  msg AS (
    SELECT date_trunc('day', m.created_at)::date AS day, count(*) AS message_count, sum(char_length(m.content))::bigint AS content_chars
    FROM messages m
    WHERE m.channel_id = p_channel_id AND m.quarantined = false
      AND m.created_at >= current_date - (greatest(p_days, 1) - 1) * interval '1 day'
    GROUP BY date_trunc('day', m.created_at)::date
  ),
  usage AS (
    SELECT date_trunc('day', u.created_at)::date AS day, sum(u.input_tokens)::bigint AS llm_input_tokens, sum(u.output_tokens)::bigint AS llm_output_tokens
    FROM llm_usage u
    WHERE u.channel_id = p_channel_id
      AND u.created_at >= current_date - (greatest(p_days, 1) - 1) * interval '1 day'
    GROUP BY date_trunc('day', u.created_at)::date
  )
  SELECT d.day, coalesce(msg.message_count, 0), coalesce(msg.content_chars, 0),
    coalesce(usage.llm_input_tokens, 0), coalesce(usage.llm_output_tokens, 0)
  FROM days d
  LEFT JOIN msg ON msg.day = d.day
  LEFT JOIN usage ON usage.day = d.day
  WHERE public.is_admin()
  ORDER BY d.day
$$;
