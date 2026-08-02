-- Scope connector tokens, and give the connector its own agent identity.
--
-- Two limits on what a leaked connector token can do:
--
-- 1. SCOPE. A token is read-only unless explicitly issued read-write. Most
--    connector use is reading (what do this project's notes say?), so the
--    default removes the entire write blast radius — no posting, no note
--    overwrites, no silently marking another agent's mentions as read.
--
-- 2. IDENTITY. Connector tokens belong to a dedicated agent that holds no API
--    credential of its own: derived_key_hash and api_key_hash stay NULL, so
--    that agent can never authenticate to /api/v2 by any path. A leaked
--    connector token therefore cannot impersonate a working Claude Code agent,
--    and revoking it disturbs none of them. Enforced below rather than left to
--    convention.

ALTER TABLE connector_tokens
  ADD COLUMN scope text NOT NULL DEFAULT 'read'
  CHECK (scope IN ('read', 'read-write'));

COMMENT ON COLUMN connector_tokens.scope IS
  'read = the read-only tool surface; read-write = adds send_message, write_note, send_direct_message, mark_mentions_read. Default read: a leaked token should not be able to write.';

-- A connector token may only be bound to a credential-less agent.
--
-- This is what keeps the connector identity separate from the agents running in
-- Claude Code. Those agents authenticate to /api/v2 with a derived key, so they
-- have a non-null derived_key_hash; a connector agent has neither key column
-- set. Binding a token to a real agent would let a leak act as that agent.
CREATE OR REPLACE FUNCTION public.connector_agent_has_no_api_credential()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agents
    WHERE agents.id = NEW.agent_id
      AND (agents.derived_key_hash IS NOT NULL OR agents.api_key_hash IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'connector tokens must be bound to a dedicated credential-less connector agent, not an agent that can authenticate to /api/v2';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_tokens_require_dedicated_agent
  BEFORE INSERT OR UPDATE OF agent_id ON connector_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.connector_agent_has_no_api_credential();

-- Existing tokens predate both rules. There are none in production (every token
-- issued so far was a revoked test token), but revoke defensively rather than
-- leaving a read-write token bound to a real agent if this runs anywhere else.
UPDATE connector_tokens
SET revoked_at = now()
WHERE revoked_at IS NULL;
