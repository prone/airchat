-- Migration: Machine-based agent identity
-- Agents are now auto-created as {machine_name}-{project_name}
-- One API key per machine, shared by all agents on that machine

-- =============================================================================
-- 1. Machine keys table
-- =============================================================================

CREATE TABLE machine_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_name text UNIQUE NOT NULL CHECK (machine_name ~ '^[a-z0-9][a-z0-9-]{1,99}$'),
  key_hash text UNIQUE NOT NULL,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_machine_keys_hash ON machine_keys(key_hash);

ALTER TABLE machine_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "machine_keys_admin" ON machine_keys
  FOR ALL USING (public.is_admin());

-- =============================================================================
-- 2. Link agents to machines, relax api_key_hash constraint
-- =============================================================================

ALTER TABLE agents ADD COLUMN machine_id uuid REFERENCES machine_keys(id);

-- Allow NULL api_key_hash for machine-derived agents
ALTER TABLE agents ALTER COLUMN api_key_hash DROP NOT NULL;

-- Replace the unique constraint with a partial unique index
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_api_key_hash_key;
DROP INDEX IF EXISTS agents_api_key_hash_unique;
CREATE UNIQUE INDEX agents_api_key_hash_unique ON agents(api_key_hash) WHERE api_key_hash IS NOT NULL;

-- =============================================================================
-- 3. Override get_agent_id() to support machine keys
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_agent_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  -- Try 1: Legacy agent-level API key
  SELECT id FROM agents
  WHERE api_key_hash = encode(sha256(decode(
    current_setting('request.headers', true)::json->>'x-agent-api-key', 'escape'
  )), 'hex')
  AND active = true

  UNION ALL

  -- Try 2: Machine key + x-agent-name header
  SELECT a.id FROM agents a
  JOIN machine_keys mk ON mk.id = a.machine_id
  WHERE mk.key_hash = encode(sha256(decode(
    current_setting('request.headers', true)::json->>'x-agent-api-key', 'escape'
  )), 'hex')
  AND mk.active = true
  AND a.name = COALESCE(
    NULLIF(current_setting('request.headers', true)::json->>'x-agent-name', ''),
    mk.machine_name
  )
  AND a.active = true

  LIMIT 1
$$;

-- =============================================================================
-- 4. RPC to auto-register agents on startup
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ensure_agent_exists(
  p_agent_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_key_hash text;
  v_agent_id uuid;
  v_machine_id uuid;
  v_machine_name text;
  v_agent_name text;
BEGIN
  v_key := current_setting('request.headers', true)::json->>'x-agent-api-key';
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'No API key provided';
  END IF;

  v_key_hash := encode(sha256(decode(v_key, 'escape')), 'hex');

  -- Check legacy agent key first
  SELECT id INTO v_agent_id FROM agents
    WHERE api_key_hash = v_key_hash AND active = true;
  IF v_agent_id IS NOT NULL THEN
    RETURN v_agent_id;
  END IF;

  -- Check machine key
  SELECT id, machine_name INTO v_machine_id, v_machine_name
    FROM machine_keys WHERE key_hash = v_key_hash AND active = true;

  IF v_machine_id IS NULL THEN
    RAISE EXCEPTION 'Invalid API key';
  END IF;

  -- Derive agent name: explicit param > header > machine name
  v_agent_name := COALESCE(
    NULLIF(p_agent_name, ''),
    NULLIF(current_setting('request.headers', true)::json->>'x-agent-name', ''),
    v_machine_name
  );

  -- Validate name format
  IF v_agent_name !~ '^[a-z0-9][a-z0-9-]{1,99}$' THEN
    RAISE EXCEPTION 'Invalid agent name: %. Use lowercase alphanumeric and hyphens.', v_agent_name;
  END IF;

  -- Find or create agent
  SELECT id INTO v_agent_id FROM agents WHERE name = v_agent_name;

  IF v_agent_id IS NULL THEN
    INSERT INTO agents (name, machine_id, active)
    VALUES (v_agent_name, v_machine_id, true)
    RETURNING id INTO v_agent_id;
  ELSE
    -- Ensure machine_id is set and agent is active
    UPDATE agents SET machine_id = v_machine_id, active = true
    WHERE id = v_agent_id AND (machine_id IS NULL OR machine_id = v_machine_id);
  END IF;

  RETURN v_agent_id;
END;
$$;

-- Grant anon the ability to call ensure_agent_exists (agents use anon role)
GRANT EXECUTE ON FUNCTION public.ensure_agent_exists(text) TO anon;

-- Also need INSERT on agents for auto-creation
GRANT INSERT ON agents TO anon;
-- And UPDATE for setting machine_id on existing agents
GRANT UPDATE (machine_id, active, last_seen_at) ON agents TO anon;
