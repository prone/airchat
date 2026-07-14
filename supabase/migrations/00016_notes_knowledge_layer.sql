-- Migration 00016: Knowledge layer (notes) — Phase 1
--
-- Durable, editable, wiki-linked notes alongside the message stream.
-- Design doc: airchat-knowledge-layer-design-plan.md v0.2
--
-- Access patterns:
--   - Agents: REST API v2 (service role, explicit scoping in adapter)
--   - Dashboard: browser client with Supabase Auth
--   - RLS below protects against direct anon-key access (see RCA:
--     rca-gossip-tables-missing-rls.md — RLS ships in the same migration
--     that creates each table, no exceptions)

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,  -- null = instance-global
  title text NOT NULL,
  body_md text NOT NULL DEFAULT '',
  properties jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES agents(id) NOT NULL,
  updated_by uuid REFERENCES agents(id) NOT NULL,
  is_stub boolean NOT NULL DEFAULT false,
  protected boolean NOT NULL DEFAULT false,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notes_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,199}$')
);

-- Slugs are strictly channel-scoped; NULL channel_id (global) gets its own scope.
CREATE UNIQUE INDEX idx_notes_scope_slug
  ON notes (COALESCE(channel_id::text, 'global'), slug);
CREATE INDEX idx_notes_channel_updated ON notes (channel_id, updated_at DESC);
CREATE INDEX idx_notes_properties ON notes USING gin (properties);

-- Full-text search, same pattern as messages.content_tsv
ALTER TABLE notes ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body_md)) STORED;
CREATE INDEX idx_notes_fts ON notes USING gin (content_tsv);

CREATE TABLE note_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid REFERENCES notes(id) ON DELETE CASCADE NOT NULL,
  revision integer NOT NULL,
  title text NOT NULL,
  body_md text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  author_agent_id uuid REFERENCES agents(id) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, revision)
);

CREATE INDEX idx_note_revisions_note ON note_revisions (note_id, revision DESC);

CREATE TYPE note_link_source AS ENUM ('note', 'message');

CREATE TABLE note_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type note_link_source NOT NULL,
  source_id uuid NOT NULL,
  -- Target is stored as (scope, slug) so links can point at not-yet-created notes
  target_channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,  -- null = global scope
  target_slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, target_channel_id, target_slug)
);

CREATE INDEX idx_note_links_target
  ON note_links (COALESCE(target_channel_id::text, 'global'), target_slug);
CREATE INDEX idx_note_links_source ON note_links (source_type, source_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;

-- Notes: agents read notes in channels they belong to, plus global notes
CREATE POLICY "notes_member_read" ON notes
  FOR SELECT USING (
    (channel_id IS NULL AND public.get_agent_id() IS NOT NULL)
    OR channel_id IN (
      SELECT channel_id FROM channel_memberships
      WHERE agent_id = public.get_agent_id()
    )
  );

-- Agents create notes as themselves, in channels they belong to (or global)
CREATE POLICY "notes_member_insert" ON notes
  FOR INSERT WITH CHECK (
    created_by = public.get_agent_id()
    AND updated_by = public.get_agent_id()
    AND (
      channel_id IS NULL
      OR channel_id IN (
        SELECT channel_id FROM channel_memberships
        WHERE agent_id = public.get_agent_id()
      )
    )
  );

-- Agents update notes in their channels; protected notes only by their creator
CREATE POLICY "notes_member_update" ON notes
  FOR UPDATE USING (
    (
      (channel_id IS NULL AND public.get_agent_id() IS NOT NULL)
      OR channel_id IN (
        SELECT channel_id FROM channel_memberships
        WHERE agent_id = public.get_agent_id()
      )
    )
    AND (NOT protected OR created_by = public.get_agent_id())
  )
  WITH CHECK (updated_by = public.get_agent_id());

CREATE POLICY "notes_admin_all" ON notes
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Revisions: readable when the parent note is readable; append-only, self-attributed
CREATE POLICY "note_revisions_member_read" ON note_revisions
  FOR SELECT USING (
    note_id IN (SELECT id FROM notes)  -- delegates to notes RLS
  );

CREATE POLICY "note_revisions_member_insert" ON note_revisions
  FOR INSERT WITH CHECK (author_agent_id = public.get_agent_id());

CREATE POLICY "note_revisions_admin_all" ON note_revisions
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Links: readable by any authenticated agent (targets are just scope+slug pairs)
CREATE POLICY "note_links_agent_read" ON note_links
  FOR SELECT USING (public.get_agent_id() IS NOT NULL);

CREATE POLICY "note_links_agent_insert" ON note_links
  FOR INSERT WITH CHECK (public.get_agent_id() IS NOT NULL);

CREATE POLICY "note_links_admin_all" ON note_links
  FOR ALL USING (auth.uid() IS NOT NULL);

-- ── Revision retention ──────────────────────────────────────────────────────
-- Every write copies the full body into note_revisions, which grows unbounded
-- under agent churn. Policy: keep all revisions newer than 90 days, plus every
-- 10th older revision (and always revision 1). Call from an admin/cron context
-- (service role); there is no in-app scheduler for this yet.

CREATE OR REPLACE FUNCTION prune_note_revisions()
RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM note_revisions r
    WHERE r.created_at < now() - interval '90 days'
      AND r.revision % 10 != 0
      AND r.revision != 1
      -- Never delete a note's current revision
      AND r.revision != (SELECT n.current_revision FROM notes n WHERE n.id = r.note_id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

-- Lock down: service role / admin only (SECURITY DEFINER function, so revoke
-- execute from the anon/authenticated roles)
REVOKE EXECUTE ON FUNCTION prune_note_revisions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prune_note_revisions() FROM anon;
REVOKE EXECUTE ON FUNCTION prune_note_revisions() FROM authenticated;

-- ── Search RPC (membership-scoped, mirrors search_messages) ─────────────────

CREATE OR REPLACE FUNCTION search_notes(
  query_text text,
  channel_filter uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  slug text,
  channel_id uuid,
  channel_name text,
  title text,
  is_stub boolean,
  updated_at timestamptz,
  rank real
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    n.id,
    n.slug,
    n.channel_id,
    c.name AS channel_name,
    n.title,
    n.is_stub,
    n.updated_at,
    ts_rank(n.content_tsv, websearch_to_tsquery('english', query_text)) AS rank
  FROM notes n
  LEFT JOIN channels c ON c.id = n.channel_id
  WHERE n.content_tsv @@ websearch_to_tsquery('english', query_text)
    AND (channel_filter IS NULL OR n.channel_id = channel_filter)
    -- SECURITY DEFINER bypasses RLS, so require an authenticated caller
    -- (agent key or dashboard Supabase Auth) explicitly
    AND (public.get_agent_id() IS NOT NULL OR auth.uid() IS NOT NULL)
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
