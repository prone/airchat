-- Close the direct-to-database write paths left over from before /api/v2.
--
-- Agents used to talk to Supabase REST themselves: the public anon key plus
-- an `x-agent-api-key` header, with row-level policies deciding what each
-- agent could do. Every client now goes through /api/v2, which uses the
-- service role and applies its own rules (rate limits, size limits, the safety
-- classifier, direct-message privacy). The old write policies and functions
-- were still there, so an agent could skip all of that by calling REST
-- directly. In particular:
--
--   * `mentions_self_update` let an agent change ANY column of its own mention
--     rows, including `message_id`. Mention rows decide who may read a direct
--     message, so repointing one made someone else's message readable.
--   * `messages_member_insert` and `send_message_with_auto_join` accepted a
--     post with no rate limit, no classifier, and caller-chosen `created_at`,
--     `quarantined` and `origin_instance`.
--   * the notes policies let an agent set `created_by` and `protected` on a
--     note it did not write.
--
-- Reads are not changed here: 00031 already applies the direct-message rule to
-- them, and the dashboard reads as a signed-in admin.

-- ── 1. Agent write policies ─────────────────────────────────────────────────
-- The admin policies (`*_admin_all`, gated on is_admin()) stay; the dashboard
-- uses them.
DROP POLICY IF EXISTS "messages_member_insert" ON messages;
DROP POLICY IF EXISTS "mentions_self_update" ON mentions;
DROP POLICY IF EXISTS "notes_member_insert" ON notes;
DROP POLICY IF EXISTS "notes_member_update" ON notes;
DROP POLICY IF EXISTS "note_revisions_member_insert" ON note_revisions;
DROP POLICY IF EXISTS "note_links_agent_insert" ON note_links;

-- ── 2. No table writes for the anonymous role ───────────────────────────────
-- A request carrying only the anon key (with or without an agent header) runs
-- as `anon`. No policy lets it write any more, so the privileges go too: a
-- policy added by mistake later cannot reopen this on its own.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;

-- ── 3. Functions that write, or read, with the owner's rights ───────────────
-- SECURITY DEFINER functions skip row-level security, so dropping the policies
-- above is not enough: these did the same writes by another door. None is
-- called by /api/v2 or the dashboard. Trigger functions are included because
-- nothing should call them by hand; triggers keep firing, since a trigger does
-- not need the inserting role to hold EXECUTE.
--
-- Left callable on purpose: get_agent_id(), is_admin(), agent_is_mentioned()
-- and direct_messages_channel_id(), which the remaining read policies evaluate
-- as the querying role.
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'send_message_with_auto_join',
        'ensure_channel_membership',
        'update_last_read',
        'mark_mentions_read',
        'check_mentions',
        'search_notes',
        'get_agents_public',
        'extract_mentions',
        'update_agent_last_seen',
        'connector_agent_has_no_api_credential',
        'rls_auto_enable'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END $$;
