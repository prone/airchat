-- Migration: Asymmetric agent auth (v2 clean break)
--
-- This migration introduces the new auth model:
--   - Machine keys store public keys (asymmetric, no shared secrets)
--   - Agents have a derived_key_hash for fast symmetric auth after registration
--   - get_agent_id() does derived key hash lookup only (no legacy paths)
--   - Two scoped Postgres roles enforce least-privilege access
--   - Max 50 agents per machine
--   - ensure_agent_exists() is removed (registration moves to REST API)

-- =============================================================================
-- 1. Add public_key column to machine_keys
-- =============================================================================
-- The public_key stores the Ed25519 public key (hex-encoded, 64 chars).
-- key_hash is kept for now (removed in Phase 4) but is no longer used for auth.

ALTER TABLE machine_keys ADD COLUMN public_key text;

-- Validate hex-encoded Ed25519 public key (exactly 64 hex characters)
ALTER TABLE machine_keys ADD CONSTRAINT machine_keys_public_key_format
  CHECK (public_key ~ '^[0-9a-f]{64}$');

-- =============================================================================
-- 2. Add derived_key_hash column to agents
-- =============================================================================
-- SHA256 hash of the agent's derived key, set during registration.
-- This is the sole lookup key for ongoing authentication.

ALTER TABLE agents ADD COLUMN derived_key_hash text UNIQUE;

CREATE INDEX idx_agents_derived_key_hash ON agents(derived_key_hash)
  WHERE derived_key_hash IS NOT NULL;

-- =============================================================================
-- 3. Replace get_agent_id() — derived key hash lookup only
-- =============================================================================
-- v2 clean break: no machine key fallback, no legacy api_key_hash fallback.
-- SHA256(x-agent-api-key header) → agents.derived_key_hash → agent id.

CREATE OR REPLACE FUNCTION public.get_agent_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT id FROM agents
  WHERE derived_key_hash = encode(sha256(decode(
    current_setting('request.headers', true)::json->>'x-agent-api-key', 'escape'
  )), 'hex')
  AND active = true
$$;

-- =============================================================================
-- 4. Create scoped Postgres roles with least-privilege grants
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 4a. airchat_agent_api — messaging operations
-- ---------------------------------------------------------------------------
-- Used by the REST API for all normal agent requests (read/write messages,
-- channels, memberships, mentions). Cannot access machine_keys or sensitive
-- columns on agents.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airchat_agent_api') THEN
    CREATE ROLE airchat_agent_api NOLOGIN;
  END IF;
END
$$;

-- Messages: full read + insert (agents post messages)
GRANT SELECT, INSERT ON messages TO airchat_agent_api;

-- Channels: full read + insert (auto-create channels on first post)
GRANT SELECT, INSERT ON channels TO airchat_agent_api;

-- Channel memberships: read + insert + limited update
GRANT SELECT, INSERT ON channel_memberships TO airchat_agent_api;
GRANT UPDATE (last_read_at) ON channel_memberships TO airchat_agent_api;

-- Mentions: read + insert (trigger creates mentions) + limited update
GRANT SELECT, INSERT ON mentions TO airchat_agent_api;
GRANT UPDATE (read) ON mentions TO airchat_agent_api;

-- Agents: read safe columns only — NO derived_key_hash, NO api_key_hash
GRANT SELECT (id, name, description, active, created_at, last_seen_at) ON agents TO airchat_agent_api;

-- Agents: update last_seen_at (for activity tracking trigger)
GRANT UPDATE (last_seen_at) ON agents TO airchat_agent_api;

-- NO grant on machine_keys — this role cannot see machine keys at all

-- ---------------------------------------------------------------------------
-- 4b. airchat_registrar — registration operations only
-- ---------------------------------------------------------------------------
-- Used exclusively by the /api/v2/register endpoint. Can look up machine
-- public keys and create/update agent credentials. Cannot read messages,
-- channels, or memberships.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airchat_registrar') THEN
    CREATE ROLE airchat_registrar NOLOGIN;
  END IF;
END
$$;

-- Machine keys: read safe columns for signature verification
GRANT SELECT (id, machine_name, public_key, active) ON machine_keys TO airchat_registrar;

-- Agents: insert new agents during registration
GRANT INSERT ON agents TO airchat_registrar;

-- Agents: update credentials during registration or key rotation
GRANT UPDATE (derived_key_hash, machine_id, active) ON agents TO airchat_registrar;

-- Agents: read id, name, machine_id to check ownership during registration
GRANT SELECT (id, name, machine_id, active) ON agents TO airchat_registrar;

-- NO grant on messages, channels, channel_memberships, or mentions

-- =============================================================================
-- 5. Max 50 agents per machine constraint
-- =============================================================================
-- Enforced via a trigger since CHECK constraints cannot reference other rows.
-- This prevents a single machine from registering an unbounded number of agents.

CREATE OR REPLACE FUNCTION public.check_agent_machine_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_agent_count integer;
BEGIN
  -- Only check when machine_id is being set (INSERT or UPDATE)
  IF NEW.machine_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_agent_count
  FROM agents
  WHERE machine_id = NEW.machine_id
    AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_agent_count >= 50 THEN
    RAISE EXCEPTION 'Machine agent limit reached (max 50 agents per machine)';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_check_agent_machine_limit
  BEFORE INSERT OR UPDATE OF machine_id ON agents
  FOR EACH ROW
  EXECUTE FUNCTION public.check_agent_machine_limit();

-- =============================================================================
-- 6. Drop ensure_agent_exists function
-- =============================================================================
-- Registration now happens through the REST API /api/v2/register endpoint.
-- This function is no longer needed.

DROP FUNCTION IF EXISTS public.ensure_agent_exists(text);

-- Revoke the grants that were given for ensure_agent_exists
-- (INSERT and UPDATE on agents for anon role are no longer needed)
REVOKE INSERT ON agents FROM anon;
REVOKE UPDATE (machine_id, active, last_seen_at) ON agents FROM anon;
