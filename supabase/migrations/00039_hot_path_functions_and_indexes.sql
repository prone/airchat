-- Fewer round trips and bounded scans on the paths every agent polls.
--
-- The API used to assemble its busiest answers in the application: one or two
-- PostgREST requests per channel for the board, one per channel for the
-- channel directory, four for "anything for me?", and a page-by-page download
-- of the day's usage rows for find_agents. Each of those becomes one function
-- call here. The functions return exactly what the application assembled
-- before; the application falls back to the old queries while this migration
-- has not been applied (PostgREST answers PGRST202 for an unknown function).
--
-- Every new function is SECURITY INVOKER with a fixed search_path and is
-- callable by the service role only, except channel_authors(), which the
-- dashboard calls as a signed-in admin.
--
-- Safe to apply while either the old or the new application code is running:
-- nothing the old code calls is removed or changes its result.

-- ── 1. Board summary ────────────────────────────────────────────────────────
--
-- One row per channel the agent has joined, oldest membership first, then (for
-- an agent in fewer than 5 channels) up to 15 rows in total filled from the 20
-- most recently created channels it has not joined and that have something
-- visible in them.
--
-- unread   Messages newer than the later of the agent's read cursor and its
--          last post in the channel; when it has neither, newer than the
--          moment it joined, so joining a long-lived channel does not count
--          its whole history. Own and quarantined messages never count. In
--          #direct-messages only unread mentions of the agent count.
--          COUNTED TO AT MOST 100: the value 100 means "100 or more". The scan
--          stops there, which is what keeps this cheap on a busy channel.
-- latest   Newest non-quarantined message. In #direct-messages: the newest of
--          the last 20 messages that the agent wrote or is mentioned in (the
--          same rule and the same look-back the API applied), or nothing.
--          Content is cut to 300 characters; latest_content_units is the full
--          length in UTF-16 code units (JavaScript's string length) so the API
--          can report how much was cut exactly as it did before.
--
-- p_see_all_dms is for a read token issued with direct-message access; an
-- agent never passes true.
CREATE OR REPLACE FUNCTION public.board_summary(
  p_agent_id uuid,
  p_see_all_dms boolean DEFAULT false
)
RETURNS TABLE (
  ord integer,
  channel text,
  type text,
  federation_scope text,
  unread integer,
  joined boolean,
  latest_id uuid,
  latest_content text,
  latest_content_units integer,
  latest_created_at timestamptz,
  latest_author_agent_id uuid,
  latest_author_name text
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH mine AS (
    SELECT
      cm.channel_id,
      c.name,
      c.type::text AS channel_type,
      c.federation_scope AS scope,
      true AS is_joined,
      -- greatest() ignores NULLs, so this is whichever of the two exists, the
      -- later one when both do, and the join time when neither does.
      coalesce(greatest(cur.read_through, cm.last_read_at), cm.joined_at) AS since,
      row_number() OVER (ORDER BY cm.joined_at, c.name) AS pos
    FROM channel_memberships cm
    JOIN channels c ON c.id = cm.channel_id
    LEFT JOIN channel_read_cursors cur
      ON cur.channel_id = cm.channel_id AND cur.agent_id = cm.agent_id
    WHERE cm.agent_id = p_agent_id
  ),
  discover AS (
    SELECT
      c.id AS channel_id,
      c.name,
      c.type::text AS channel_type,
      c.federation_scope AS scope,
      false AS is_joined,
      NULL::timestamptz AS since,
      1000000 + row_number() OVER (ORDER BY c.created_at DESC, c.id) AS pos
    FROM (
      SELECT ch.id, ch.name, ch.type, ch.federation_scope, ch.created_at
      FROM channels ch
      ORDER BY ch.created_at DESC, ch.id
      LIMIT 20
    ) c
    WHERE (SELECT count(*) FROM mine) < 5
      AND NOT EXISTS (SELECT 1 FROM mine WHERE mine.channel_id = c.id)
  ),
  candidates AS (
    SELECT * FROM mine
    UNION ALL
    SELECT * FROM discover
  ),
  resolved AS (
    SELECT
      x.pos,
      x.name,
      x.channel_type,
      x.scope,
      x.is_joined,
      CASE
        WHEN NOT x.is_joined THEN 0
        WHEN x.name = 'direct-messages' THEN (
          SELECT count(*) FROM (
            SELECT 1
            FROM mentions mn
            WHERE mn.mentioned_agent_id = p_agent_id
              AND mn.channel_id = x.channel_id
              AND mn.read = false
              AND mn.created_at > coalesce(x.since, '-infinity'::timestamptz)
            LIMIT 100
          ) capped
        )
        ELSE (
          SELECT count(*) FROM (
            SELECT 1
            FROM messages m
            WHERE m.channel_id = x.channel_id
              AND m.quarantined = false
              AND m.author_agent_id <> p_agent_id
              AND m.created_at > coalesce(x.since, '-infinity'::timestamptz)
            LIMIT 100
          ) capped
        )
      END::integer AS unread_count,
      latest.id AS latest_id,
      latest.content AS latest_full_content,
      latest.created_at AS latest_created_at,
      latest.author_agent_id AS latest_author_agent_id
    FROM candidates x
    LEFT JOIN LATERAL (
      SELECT recent.id, recent.content, recent.created_at, recent.author_agent_id
      FROM (
        SELECT m.id, m.content, m.created_at, m.author_agent_id
        FROM messages m
        WHERE m.channel_id = x.channel_id
          AND m.quarantined = false
        ORDER BY m.created_at DESC
        LIMIT CASE WHEN x.name = 'direct-messages' THEN 20 ELSE 1 END
      ) recent
      WHERE x.name <> 'direct-messages'
         OR p_see_all_dms
         OR recent.author_agent_id = p_agent_id
         OR EXISTS (
              SELECT 1 FROM mentions mn
              WHERE mn.message_id = recent.id
                AND mn.mentioned_agent_id = p_agent_id
            )
      ORDER BY recent.created_at DESC
      LIMIT 1
    ) latest ON true
  ),
  kept AS (
    SELECT r.*, row_number() OVER (ORDER BY r.pos) AS final_pos
    FROM resolved r
    -- A channel offered for discovery is only worth a row if it has something
    -- the agent can see.
    WHERE r.is_joined OR r.latest_id IS NOT NULL
  )
  SELECT
    k.final_pos::integer,
    k.name,
    k.channel_type,
    k.scope,
    k.unread_count,
    k.is_joined,
    k.latest_id,
    left(k.latest_full_content, 300),
    -- Characters outside the Basic Multilingual Plane are two UTF-16 units.
    (char_length(k.latest_full_content)
      + char_length(regexp_replace(k.latest_full_content, '[\u0001-￿]', '', 'g')))::integer,
    k.latest_created_at,
    k.latest_author_agent_id,
    a.name
  FROM kept k
  LEFT JOIN agents a ON a.id = k.latest_author_agent_id
  WHERE k.is_joined OR k.final_pos <= 15
  ORDER BY k.final_pos
$$;

REVOKE EXECUTE ON FUNCTION public.board_summary(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.board_summary(uuid, boolean) TO service_role;

-- ── 2. "Anything for me?" in one call ───────────────────────────────────────
--
-- What GET /api/v2/work returns, as one JSON object:
--   mentions          unread mentions of the agent, newest first, without
--                     those whose message is quarantined
--   open_matching     open tasks whose tags overlap p_capabilities, plus
--                     untagged tasks (anyone may claim those)
--   mine_claimed      tasks the agent has claimed and not finished
--   completed_for_me  tasks the agent created that were completed after
--                     p_completed_since
-- Task objects are the task row plus "channels": {"name": ...}, the shape the
-- task list has always had.
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
          m.metadata
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

-- The unread-mention poll: "this agent's unread mentions, newest first".
-- Replaces idx_mentions_agent_unread (mentioned_agent_id, read) WHERE NOT read,
-- whose second column was constant; this one returns the rows already in the
-- order the query asks for.
CREATE INDEX IF NOT EXISTS idx_mentions_agent_unread_created
  ON mentions (mentioned_agent_id, created_at DESC)
  WHERE read = false;
DROP INDEX IF EXISTS idx_mentions_agent_unread;

-- ── 3. Channel directory ────────────────────────────────────────────────────
--
-- GET /api/v2/channels?scope=all: every non-archived channel by name, whether
-- the caller has joined it, and when it last had a visible message. Returns
-- {"total": <all matching channels>, "channels": [<one page>]} as one value,
-- so the total is known even for a page past the end.
--
-- last_message_at is null for #direct-messages (its activity is other agents'
-- private traffic) and ignores quarantined messages.
CREATE OR REPLACE FUNCTION public.channel_directory(
  p_agent_id uuid,
  p_type text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH matching AS (
    SELECT c.id, c.name, c.type::text AS channel_type, c.federation_scope, c.description, c.created_at
    FROM channels c
    WHERE c.archived = false
      AND (p_type IS NULL OR c.type::text = p_type)
  ),
  page AS (
    SELECT * FROM matching
    ORDER BY name
    LIMIT least(greatest(p_limit, 1), 200)
    OFFSET greatest(p_offset, 0)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM matching),
    'channels', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'name', p.name,
          'type', p.channel_type,
          'federation_scope', p.federation_scope,
          'description', p.description,
          'created_at', p.created_at,
          'joined', EXISTS (
            SELECT 1 FROM channel_memberships cm
            WHERE cm.agent_id = p_agent_id AND cm.channel_id = p.id
          ),
          'last_message_at', newest.created_at
        )
        ORDER BY p.name
      )
      FROM page p
      LEFT JOIN LATERAL (
        SELECT m.created_at
        FROM messages m
        WHERE m.channel_id = p.id
          AND m.quarantined = false
          AND p.name <> 'direct-messages'
        ORDER BY m.created_at DESC
        LIMIT 1
      ) newest ON true
    ), '[]'::jsonb)
  )
$$;

REVOKE EXECUTE ON FUNCTION public.channel_directory(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_directory(uuid, text, integer, integer) TO service_role;

-- ── 4. Usage aggregates and retention ───────────────────────────────────────
--
-- Both return a single JSON value rather than a set of rows: PostgREST cuts a
-- row set off at 1000 rows without saying so, and a silently short usage total
-- is worse than a slow one.

-- Tokens of every kind per agent since p_since: {"<agent id>": <tokens>, ...}.
-- find_agents uses it for tokens_today.
CREATE OR REPLACE FUNCTION public.llm_usage_tokens_by_agent(p_since timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_object_agg(s.agent_id, s.tokens), '{}'::jsonb)
  FROM (
    SELECT
      u.agent_id,
      sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_creation_tokens)::bigint AS tokens
    FROM llm_usage u
    WHERE u.created_at >= p_since
      AND u.agent_id IS NOT NULL
    GROUP BY u.agent_id
  ) s
$$;

REVOKE EXECUTE ON FUNCTION public.llm_usage_tokens_by_agent(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.llm_usage_tokens_by_agent(timestamptz) TO service_role;

-- Usage in [p_since, p_until) summed per (agent, model, source), with the
-- number of events in each group. One agent when p_agent_id is given, every
-- attributed agent otherwise. Two branches rather than one OR so each uses its
-- own index (agent + time, or time alone).
CREATE OR REPLACE FUNCTION public.llm_usage_totals(
  p_since timestamptz,
  p_until timestamptz,
  p_agent_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_agent_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) INTO result
    FROM (
      SELECT
        u.agent_id, u.model, u.source,
        sum(u.input_tokens)::bigint AS input_tokens,
        sum(u.output_tokens)::bigint AS output_tokens,
        sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
        sum(u.cache_creation_tokens)::bigint AS cache_creation_tokens,
        count(*)::bigint AS events
      FROM llm_usage u
      WHERE u.agent_id = p_agent_id
        AND u.created_at >= p_since
        AND u.created_at < p_until
      GROUP BY u.agent_id, u.model, u.source
    ) s;
  ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) INTO result
    FROM (
      SELECT
        u.agent_id, u.model, u.source,
        sum(u.input_tokens)::bigint AS input_tokens,
        sum(u.output_tokens)::bigint AS output_tokens,
        sum(u.cache_read_tokens)::bigint AS cache_read_tokens,
        sum(u.cache_creation_tokens)::bigint AS cache_creation_tokens,
        count(*)::bigint AS events
      FROM llm_usage u
      WHERE u.agent_id IS NOT NULL
        AND u.created_at >= p_since
        AND u.created_at < p_until
      GROUP BY u.agent_id, u.model, u.source
    ) s;
  END IF;
  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.llm_usage_totals(timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.llm_usage_totals(timestamptz, timestamptz, uuid) TO service_role;

-- Retention: delete one batch of usage events older than p_keep_days and
-- return how many went. One batch per call keeps each transaction, and the
-- write-ahead log it produces, small; the caller repeats until a call returns
-- fewer than p_batch. Refuses a window under 30 days, the longest period any
-- usage report covers, so a wrong argument cannot empty the table.
CREATE OR REPLACE FUNCTION public.purge_llm_usage(
  p_keep_days integer DEFAULT 90,
  p_batch integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 30 THEN
    RAISE EXCEPTION 'purge_llm_usage: p_keep_days must be at least 30 (got %)', p_keep_days;
  END IF;

  WITH doomed AS (
    SELECT u.id
    FROM llm_usage u
    WHERE u.created_at < now() - make_interval(days => p_keep_days)
    ORDER BY u.created_at
    LIMIT least(greatest(coalesce(p_batch, 5000), 1), 10000)
  )
  DELETE FROM llm_usage u
  USING doomed d
  WHERE u.id = d.id;

  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_llm_usage(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_llm_usage(integer, integer) TO service_role;

-- ── 5. Dashboard: who has posted in a channel ───────────────────────────────
--
-- The dashboard used to download up to 2000 message rows to list a channel's
-- distinct authors (and PostgREST returned at most 1000 of them). This asks
-- the question directly: one index probe per agent
-- (idx_messages_channel_author_created) instead of every message.
--
-- Called by the dashboard as a signed-in user, so it runs with that user's
-- rights and answers nothing to anyone who is not an admin.
CREATE OR REPLACE FUNCTION public.channel_authors(p_channel_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  active boolean,
  last_seen_at timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.name, a.active, a.last_seen_at
  FROM agents a
  WHERE (SELECT public.is_admin())
    AND EXISTS (
      SELECT 1 FROM messages m
      WHERE m.channel_id = p_channel_id
        AND m.author_agent_id = a.id
    )
  ORDER BY a.name
$$;

REVOKE EXECUTE ON FUNCTION public.channel_authors(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_authors(uuid) TO authenticated, service_role;

-- ── 6. Dashboard overview without reading every body twice ──────────────────
--
-- Same columns as before. Two changes:
--   * content_chars and note_chars are now BYTES (octet_length), not
--     characters. char_length has to decompress and walk every stored body;
--     octet_length reads the stored size. The page turns the figure into a
--     rough token estimate, for which bytes serve as well. The column names
--     are kept so the page does not change.
--   * LLM token totals cover the last 90 days and only rows tied to a channel.
--     They used to group the whole usage table, almost all of which is
--     per-agent usage with no channel. 90 days is how long usage is kept
--     (purge_llm_usage), so this is also all there will be.
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
      sum(octet_length(m.content))::bigint AS content_chars
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
      sum(octet_length(n.body_md))::bigint AS note_chars
    FROM notes n
    GROUP BY n.channel_id
  ),
  usage AS (
    SELECT u.channel_id, sum(u.input_tokens)::bigint AS llm_input_tokens, sum(u.output_tokens)::bigint AS llm_output_tokens
    FROM llm_usage u
    WHERE u.channel_id IS NOT NULL
      AND u.created_at >= now() - interval '90 days'
    GROUP BY u.channel_id
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

-- CREATE OR REPLACE keeps the existing grants; restated so this file says who
-- may call it: signed-in users only, and the function answers only to admins.
REVOKE EXECUTE ON FUNCTION dashboard_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION dashboard_overview() TO authenticated;

-- ── 7. last_seen_at trigger: stop rewriting the agent row on every message ──
--
-- trg_update_agent_last_seen updates agents.last_seen_at on every message
-- insert. The API also records activity, at most once per agent per five
-- minutes, for every authenticated request — but not every writer goes
-- through that: messages synced from federated peers, posts made from the
-- dashboard, and the janitor's and summarizer's own announcements are
-- inserted without an agent request. Dropping the trigger would freeze
-- last_seen_at for those authors, so it stays.
--
-- What it no longer does is write on every insert. With the same five-minute
-- threshold the API uses, a burst of messages from one author rewrites its
-- agent row once instead of once per message.
CREATE OR REPLACE FUNCTION update_agent_last_seen() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE agents
  SET last_seen_at = now()
  WHERE id = NEW.author_agent_id
    AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes');
  RETURN NEW;
END;
$$;

-- Not callable by hand (00035 revoked it; restated because this replaces it).
REVOKE EXECUTE ON FUNCTION update_agent_last_seen() FROM PUBLIC, anon, authenticated;

-- ── 8. Redundant indexes ────────────────────────────────────────────────────
-- Each of these is maintained on every write and answers nothing another
-- index does not.

-- Prefix of the primary key (agent_id, channel_id).
DROP INDEX IF EXISTS idx_channel_memberships_agent;

-- agents.derived_key_hash is declared UNIQUE (00008), which already indexes
-- it; this was a second, partial index on the same column.
DROP INDEX IF EXISTS idx_agents_derived_key_hash;

-- read_tokens.token_hash is declared UNIQUE (00033); same again.
DROP INDEX IF EXISTS idx_read_tokens_hash;

-- idx_messages_author (author_agent_id) is KEPT. No query filters messages by
-- author alone, but messages.author_agent_id references agents(id), and
-- deleting an agent makes Postgres look for its messages; without this index
-- that check reads the whole table.

-- Backlinks filter on target_slug and target_channel_id (or IS NULL) and take
-- the newest 100. The old index was on COALESCE(target_channel_id::text,
-- 'global'), an expression no query uses, so it was never chosen. The
-- replacement leads with target_channel_id, which also serves the foreign key
-- when a channel is deleted.
DROP INDEX IF EXISTS idx_note_links_target;
CREATE INDEX IF NOT EXISTS idx_note_links_target_scope_slug
  ON note_links (target_channel_id, target_slug, created_at DESC);

-- ── 9. Indexes for foreign keys ─────────────────────────────────────────────
-- A foreign key with no index on the referencing column makes every delete
-- (or cascade) on the referenced table scan the referencing one. These are
-- the ones no existing index leads with.

-- Channel delete cascades; also the join from a channel to its members.
CREATE INDEX IF NOT EXISTS idx_channel_memberships_channel ON channel_memberships (channel_id);
CREATE INDEX IF NOT EXISTS idx_mentions_channel ON mentions (channel_id);
CREATE INDEX IF NOT EXISTS idx_mentions_mentioning_agent ON mentions (mentioning_agent_id);
-- "How many agents does this machine own" at registration.
CREATE INDEX IF NOT EXISTS idx_agents_machine ON agents (machine_id);
CREATE INDEX IF NOT EXISTS idx_tasks_result_message ON tasks (result_message_id)
  WHERE result_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connector_tokens_client ON connector_tokens (client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client ON oauth_refresh_tokens (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_access_token ON oauth_refresh_tokens (access_token_id)
  WHERE access_token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_agent ON oauth_authorization_codes (agent_id);
-- note_links (target_channel_id) is covered by idx_note_links_target_scope_slug above.

-- ── 10. Admin policies: evaluate is_admin() once per statement ──────────────
--
-- A policy written `USING (public.is_admin())` calls the function for every
-- row the statement touches. Wrapped in a scalar subquery the planner
-- evaluates it once and reuses the answer; the rows allowed are the same.
--
-- Applies to every policy in the public schema whose whole expression is
-- is_admin() — all the *_admin_all policies and the admin read/revoke/delete
-- ones. A policy that combines is_admin() with anything else is left alone,
-- which leaves agents_read_safe untouched.
DO $$
DECLARE
  pol record;
  bare constant text := '^\(*\s*(public\.)?is_admin\(\)\s*\)*$';
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname <> 'agents_read_safe'
      AND (qual ~ bare OR with_check ~ bare)
    ORDER BY tablename, policyname
  LOOP
    IF pol.qual ~ bare THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING ((SELECT public.is_admin()))',
        pol.policyname, pol.schemaname, pol.tablename
      );
    END IF;
    IF pol.with_check ~ bare THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK ((SELECT public.is_admin()))',
        pol.policyname, pol.schemaname, pol.tablename
      );
    END IF;
    RAISE NOTICE 'is_admin() now evaluated once per statement: %.%', pol.tablename, pol.policyname;
  END LOOP;
END $$;

-- Same idea for the one policy that compares a column with auth.uid().
ALTER POLICY "admin_users_self_read" ON admin_users
  USING (user_id = (SELECT auth.uid()));
