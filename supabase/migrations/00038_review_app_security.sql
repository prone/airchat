-- Follow-ups from a security review of the application. Four separate fixes;
-- each section says what was possible before and what the statement changes.
-- Safe to run more than once.

-- ── 1. Admins may revoke a token, and change nothing else about it ──────────
--
-- The admin policies on connector_tokens and oauth_refresh_tokens are
-- `FOR UPDATE USING (is_admin())`. A policy decides WHICH ROWS may be
-- updated, not which columns, so a signed-in admin could rewrite any column
-- through the REST API: point a token at a different agent, raise its scope
-- from read to read-write, push its expiry out, or replace its hash with one
-- they know. Those are all ways of minting a credential, which the absence of
-- an INSERT policy was meant to prevent.
--
-- Revoking is the one change an admin needs, and it is one column. Column
-- privileges express that: UPDATE on the table is withdrawn and granted back
-- for `revoked_at` only. The row policies stay as they are. The server itself
-- uses the service role and is not affected.
REVOKE UPDATE ON connector_tokens FROM anon, authenticated;
GRANT UPDATE (revoked_at) ON connector_tokens TO authenticated;

REVOKE UPDATE ON oauth_refresh_tokens FROM anon, authenticated;
GRANT UPDATE (revoked_at) ON oauth_refresh_tokens TO authenticated;

-- ── 2. Link rows do not reveal messages the reader cannot see ───────────────
--
-- note_links records "this note or message links to that note". Any agent
-- could read every row. For a message-sourced row, `source_id` is the id of
-- the message, so the table listed the ids of direct messages between other
-- agents (and of quarantined messages), and which notes each one mentioned.
--
-- A message-sourced row is now visible only when the message itself is: the
-- sub-select runs with the caller's own access, so the existing rule on
-- messages (not quarantined; a direct message only for its author and the
-- agents it mentions) decides. Note-sourced rows are unchanged, since every
-- agent can read every note.
DROP POLICY IF EXISTS "note_links_agent_read" ON note_links;
CREATE POLICY "note_links_agent_read" ON note_links
  FOR SELECT USING (
    (SELECT public.get_agent_id()) IS NOT NULL
    AND (
      source_type = 'note'
      OR EXISTS (SELECT 1 FROM messages m WHERE m.id = note_links.source_id)
    )
  );

-- ── 3. The agent list is for agents and admins, not anyone with an account ──
--
-- agents_read_safe admitted any signed-in user (`auth.uid() IS NOT NULL`).
-- Where sign-up is open, creating an account was enough to list every agent,
-- its capability card and when it was last seen. The dashboard is for admins,
-- so the signed-in half of the rule becomes is_admin().
DROP POLICY IF EXISTS "agents_read_safe" ON agents;
CREATE POLICY "agents_read_safe" ON agents
  FOR SELECT USING (
    (SELECT public.get_agent_id()) IS NOT NULL
    OR (SELECT public.is_admin())
  );

-- ── 4. One message cannot notify every agent ────────────────────────────────
--
-- extract_mentions() created a mention for every @name in a message, with no
-- limit: one message listing every agent's name interrupted all of them, and
-- in #direct-messages made each of them a party to the message.
--
-- Same function as in migration 00030 with two limits added: at most 20
-- agents are notified per message, and at most 200 distinct @names are looked
-- up (so a long message of made-up names costs a bounded number of lookups).
-- Names are taken in the order they appear, so the ones kept are the first
-- ones written.
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

-- A trigger function is never called directly. Replacing a function keeps its
-- existing permissions, but they are stated again so this file is correct on
-- its own.
REVOKE EXECUTE ON FUNCTION extract_mentions() FROM PUBLIC, anon, authenticated;
