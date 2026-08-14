-- Migration 00028: per-agent token usage tracking
--
-- Extends llm_usage from a server-only Anthropic ledger into the general
-- per-agent usage event stream (the "usage_events" design from the token
-- tracking roadmap; the table keeps its name so dashboard_overview() and
-- channel_activity_timeline() keep working unchanged).
--
-- New event sources, alongside the existing server-side rows:
--   native — exact counts from a provider response (Anthropic usage object,
--            Ollama prompt_eval_count/eval_count, OpenAI-compat usage).
--            Existing summarize/digest rows are native.
--   self   — agent self-reports via the report_token_usage MCP tool
--            (cumulative counters; the server stores computed deltas).
--   served — AirChat's own estimate of tokens it fed into an agent's context
--            (chars/4 over tool responses). The only zero-cooperation metric.
--
-- Dollars are never stored — they are derived at read time from model_prices
-- so price changes never rot history. Eventually this stream merges into the
-- E-B3 audit log (one event stream, security + finance views).

-- ── llm_usage: agent attribution + 4-way token split ────────────────────────

ALTER TABLE llm_usage
  ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN session_id text CHECK (char_length(session_id) <= 200),
  ADD COLUMN source text NOT NULL DEFAULT 'native'
    CHECK (source IN ('native', 'self', 'served')),
  ADD COLUMN cache_read_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN cache_creation_tokens integer NOT NULL DEFAULT 0;

-- Negative counts can only come from delta-computation bugs; reject at the DB.
ALTER TABLE llm_usage
  ADD CONSTRAINT llm_usage_nonnegative CHECK (
    input_tokens >= 0 AND output_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_creation_tokens >= 0
  );

CREATE INDEX idx_llm_usage_agent ON llm_usage (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;

-- ── Self-report cursors ─────────────────────────────────────────────────────
-- report_token_usage sends CUMULATIVE per-session counters (OTel-style), so
-- retries can never double-count. The cursor holds the last cumulative totals
-- per (agent, session, model); the served event row stores the delta. A
-- counter below the cursor means the session restarted its counting — the
-- reported value is then taken as the whole delta.

CREATE TABLE usage_report_cursors (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, session_id, model)
);

ALTER TABLE usage_report_cursors ENABLE ROW LEVEL SECURITY;

-- Written by the service role only; dashboard admins may inspect.
CREATE POLICY "usage_report_cursors_admin_read" ON usage_report_cursors
  FOR SELECT USING (public.is_admin());

-- ── Model price table ───────────────────────────────────────────────────────
-- USD per million tokens, 4-way split (cache reads are ~10x cheaper than
-- input; a blended number lies). Edited without a deploy; costs are computed
-- at read time by joining events to this table. An agent whose card declares
-- plan 'local' or 'subscription' costs $0 marginal regardless of this table —
-- the $0 is displayed, not omitted: it IS the savings metric.

CREATE TABLE model_prices (
  model text PRIMARY KEY CHECK (char_length(model) BETWEEN 1 AND 200),
  input_per_mtok numeric NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok numeric NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok numeric NOT NULL CHECK (cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric NOT NULL CHECK (cache_write_per_mtok >= 0),
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "model_prices_admin_read" ON model_prices
  FOR SELECT USING (public.is_admin());

-- Seed: Anthropic first-party API list prices, verified against
-- docs.claude.com 2026-08-14. Cache write priced at the default 5-minute TTL
-- rate (1.25x input); 1-hour TTL writes bill at 2x input — if the fleet ever
-- uses 1h caching, either add dedicated rows or accept the underestimate.
-- Cache read = 0.1x input across the family.
INSERT INTO model_prices (model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, notes) VALUES
  ('claude-fable-5',           10.00, 50.00, 1.00, 12.50, 'Anthropic list price'),
  ('claude-opus-5',             5.00, 25.00, 0.50,  6.25, 'Anthropic list price'),
  ('claude-opus-4-8',           5.00, 25.00, 0.50,  6.25, 'Anthropic list price'),
  ('claude-opus-4-7',           5.00, 25.00, 0.50,  6.25, 'Anthropic list price'),
  ('claude-sonnet-5',           2.00, 10.00, 0.20,  2.50, 'Anthropic list price (NOT 3/15 — that was Sonnet 4.x)'),
  ('claude-sonnet-4-6',         3.00, 15.00, 0.30,  3.75, 'Anthropic list price'),
  ('claude-sonnet-4-5',         3.00, 15.00, 0.30,  3.75, 'Anthropic list price'),
  ('claude-haiku-4-5',          1.00,  5.00, 0.10,  1.25, 'Anthropic list price'),
  ('claude-haiku-4-5-20251001', 1.00,  5.00, 0.10,  1.25, 'Anthropic list price (dated ID)');

-- ── Per-agent usage rollup for the dashboard ────────────────────────────────
-- The fleet page (browser, anon key + RLS) needs per-agent daily aggregates
-- without shipping raw events to the client. Admin-gated like the other
-- dashboard aggregates (00021 pattern).

CREATE OR REPLACE FUNCTION agent_usage_rollup(p_days integer DEFAULT 7)
RETURNS TABLE (
  agent_id uuid,
  day date,
  model text,
  source text,
  input_tokens bigint,
  output_tokens bigint,
  cache_read_tokens bigint,
  cache_creation_tokens bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.agent_id,
    date_trunc('day', u.created_at)::date AS day,
    u.model,
    u.source,
    sum(u.input_tokens)::bigint,
    sum(u.output_tokens)::bigint,
    sum(u.cache_read_tokens)::bigint,
    sum(u.cache_creation_tokens)::bigint
  FROM llm_usage u
  WHERE u.agent_id IS NOT NULL
    AND u.created_at >= current_date - (greatest(least(p_days, 90), 1) - 1) * interval '1 day'
    AND public.is_admin()
  GROUP BY u.agent_id, date_trunc('day', u.created_at)::date, u.model, u.source
$$;

REVOKE EXECUTE ON FUNCTION agent_usage_rollup(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION agent_usage_rollup(integer) FROM anon;
GRANT EXECUTE ON FUNCTION agent_usage_rollup(integer) TO authenticated;

-- Dashboard admins also read model_prices directly (policy above) to derive
-- display costs client-side with the shared costing function.
