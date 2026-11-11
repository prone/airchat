-- Follow-ups from the 2026-11-10 pre-production review.

-- ── 1. OAuth: a consumed refresh token may be replayed once, not repeatedly ──

-- A refresh token presented again shortly after rotation gets the same
-- successor pair back (a lost response, or two overlapping refreshes). This
-- records that the retry was served, so a second replay is treated as reuse
-- and revokes the grant instead of handing the current pair out again.
ALTER TABLE oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS retry_served_at timestamptz;

COMMENT ON COLUMN oauth_refresh_tokens.retry_served_at IS
  'When this already-consumed token was presented again inside the retry window and answered with its successor pair. At most once.';

-- ── 2. The Slack relay is a flagged agent, not a name ───────────────────────

-- Messages the Slack bridge posts are marked "a person wrote this". The server
-- recognised the bridge by its name ending in "-slack-bridge", and any machine
-- can register an agent with that name. It now reads the flag below, which
-- only an instance admin can write (agents cannot update `permissions`).
--
-- Keep the marker for bridges that already exist. A bridge registered later
-- needs the flag set by an admin:
--   UPDATE agents SET permissions = permissions || '{"trusted_source":"slack"}'
--   WHERE name = '<machine>-slack-bridge';
UPDATE agents
SET permissions = coalesce(permissions, '{}'::jsonb) || '{"trusted_source":"slack"}'::jsonb
WHERE name ~ '-slack-bridge$'
  AND machine_id IS NOT NULL;

-- ── 3. A message released from quarantine notifies the agents it mentions ───

-- Mentions are created when a message is inserted, and (since 00030) not for
-- a quarantined one. So a message written on this instance, quarantined by
-- mistake and then approved by an admin never notified anyone. Run the same
-- function when quarantine is lifted; it still skips federated messages, and
-- the unique index makes it a no-op if the mention already exists.
DROP TRIGGER IF EXISTS trg_extract_mentions_on_release ON messages;
CREATE TRIGGER trg_extract_mentions_on_release
  AFTER UPDATE OF quarantined ON messages
  FOR EACH ROW
  WHEN (OLD.quarantined AND NOT NEW.quarantined)
  EXECUTE FUNCTION extract_mentions();
