-- Migration 00018: Visualization layer — LLM usage tracking + dashboard aggregates
--
-- 1. llm_usage: one row per Anthropic API call made by the server (currently
--    the daily-digest summarizer). Gives humans visibility into API spend.
-- 2. dashboard_overview(): per-channel aggregates for the dashboard overview
--    page in one round trip (message volume + provenance, content size,
--    garden stats, LLM token spend).
--
-- Access: llm_usage is written by the server (service role) and read by the
-- authenticated dashboard. RLS ships in this migration (see RCA:
-- rca-gossip-tables-missing-rls.md).

-- ── LLM usage ledger ────────────────────────────────────────────────────────

CREATE TABLE llm_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL,                                -- e.g. 'daily-digest'
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}',                 -- e.g. {note_slug, date}
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_usage_created ON llm_usage (created_at DESC);
CREATE INDEX idx_llm_usage_channel ON llm_usage (channel_id, created_at DESC);

ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;

-- Dashboard humans read; no agent/anon access. Writes come from the service
-- role (bypasses RLS).
CREATE POLICY "llm_usage_admin_read" ON llm_usage
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ── Dashboard overview aggregates ───────────────────────────────────────────
-- Provenance classes:
--   human message  = posted via dashboard/Slack bridge (metadata.source) or by
--                    the dashboard-admin agent
--   agent message  = everything else
--   (notes: human = updated_by_user set; summarizer = author named 'summarizer')

CREATE OR REPLACE FUNCTION dashboard_overview()
RETURNS TABLE (
  channel_id uuid,
  channel_name text,
  channel_type text,
  federation_scope text,
  message_count bigint,
  human_message_count bigint,
  last_message_at timestamptz,
  content_chars bigint,
  messages_by_day jsonb,
  note_count bigint,
  stub_count bigint,
  digest_count bigint,
  latest_digest_slug text,
  note_chars bigint,
  llm_input_tokens bigint,
  llm_output_tokens bigint
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
    SELECT
      u.channel_id,
      sum(u.input_tokens)::bigint AS llm_input_tokens,
      sum(u.output_tokens)::bigint AS llm_output_tokens
    FROM llm_usage u
    GROUP BY u.channel_id
  )
  SELECT
    c.id,
    c.name,
    c.type::text,
    c.federation_scope,
    coalesce(msg.message_count, 0),
    coalesce(msg.human_message_count, 0),
    msg.last_message_at,
    coalesce(msg.content_chars, 0),
    coalesce(by_day.days, '[]'::jsonb),
    coalesce(nts.note_count, 0),
    coalesce(nts.stub_count, 0),
    coalesce(nts.digest_count, 0),
    nts.latest_digest_slug,
    coalesce(nts.note_chars, 0),
    coalesce(usage.llm_input_tokens, 0),
    coalesce(usage.llm_output_tokens, 0)
  FROM channels c
  LEFT JOIN msg ON msg.channel_id = c.id
  LEFT JOIN by_day ON by_day.channel_id = c.id
  LEFT JOIN nts ON nts.channel_id = c.id
  LEFT JOIN usage ON usage.channel_id = c.id
  WHERE c.archived = false
    -- SECURITY DEFINER bypasses RLS: dashboard humans only
    AND auth.uid() IS NOT NULL
  ORDER BY msg.last_message_at DESC NULLS LAST
$$;

REVOKE EXECUTE ON FUNCTION dashboard_overview() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION dashboard_overview() FROM anon;
GRANT EXECUTE ON FUNCTION dashboard_overview() TO authenticated;
