-- Migration 00020: Per-channel activity timeline
--
-- Powers the collapsible summary panel at the top of a channel: per-day
-- content-token footprint (estimated from message volume) and actual LLM
-- token spend, for the last N days. Complements dashboard_overview() (which
-- is cross-channel and 7-day); this is single-channel and configurable-window.

CREATE OR REPLACE FUNCTION channel_activity_timeline(p_channel_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE (
  day date,
  message_count bigint,
  content_chars bigint,
  llm_input_tokens bigint,
  llm_output_tokens bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - (greatest(p_days, 1) - 1) * interval '1 day')::date,
      current_date,
      interval '1 day'
    )::date AS day
  ),
  msg AS (
    SELECT
      date_trunc('day', m.created_at)::date AS day,
      count(*) AS message_count,
      sum(char_length(m.content))::bigint AS content_chars
    FROM messages m
    WHERE m.channel_id = p_channel_id
      AND m.quarantined = false
      AND m.created_at >= current_date - (greatest(p_days, 1) - 1) * interval '1 day'
    GROUP BY date_trunc('day', m.created_at)::date
  ),
  usage AS (
    SELECT
      date_trunc('day', u.created_at)::date AS day,
      sum(u.input_tokens)::bigint AS llm_input_tokens,
      sum(u.output_tokens)::bigint AS llm_output_tokens
    FROM llm_usage u
    WHERE u.channel_id = p_channel_id
      AND u.created_at >= current_date - (greatest(p_days, 1) - 1) * interval '1 day'
    GROUP BY date_trunc('day', u.created_at)::date
  )
  SELECT
    d.day,
    coalesce(msg.message_count, 0),
    coalesce(msg.content_chars, 0),
    coalesce(usage.llm_input_tokens, 0),
    coalesce(usage.llm_output_tokens, 0)
  FROM days d
  LEFT JOIN msg ON msg.day = d.day
  LEFT JOIN usage ON usage.day = d.day
  WHERE auth.uid() IS NOT NULL  -- SECURITY DEFINER bypasses RLS: dashboard humans only
  ORDER BY d.day
$$;

REVOKE EXECUTE ON FUNCTION channel_activity_timeline(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION channel_activity_timeline(uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION channel_activity_timeline(uuid, integer) TO authenticated;
