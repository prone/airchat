-- Connector tokens: a credential class for the claude.ai MCP connector.
--
-- Deliberately SEPARATE from agents.derived_key_hash. The derived agent key is
-- accepted by every /api/v2 route with no scope, no expiry and no audience.
-- Handing that key to a third-party connector would mean a leak there grants
-- full API access. A connector token is only ever checked by /api/mcp, so
-- audience binding is structural rather than something enforced after the fact:
-- there is no code path that accepts a connector token anywhere else.
--
-- Tokens are stored as SHA256 hashes, never in plaintext, matching the
-- derived_key_hash model. The plaintext is shown once at issuance.

CREATE TABLE connector_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  -- Human-readable label so a user can tell two connectors apart when revoking.
  name           text NOT NULL,
  -- Null means "never expires". Prefer setting one.
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Auth lookup is on the hash, and only live tokens can ever authenticate.
CREATE INDEX idx_connector_tokens_hash
  ON connector_tokens(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_connector_tokens_agent ON connector_tokens(agent_id);

COMMENT ON TABLE connector_tokens IS
  'Bearer credentials for the claude.ai MCP connector. Checked only by /api/mcp — never by /api/v2, which is what audience-binds them.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every table gets RLS enabled (see the RLS incident and the CI check that
-- enforces this). These rows are credentials: no anon or authenticated role
-- has any business reading them. Only the service role, which bypasses RLS,
-- touches this table — so RLS is on with NO permissive policy at all.

ALTER TABLE connector_tokens ENABLE ROW LEVEL SECURITY;

-- Admins can list and revoke from the dashboard, but deliberately cannot
-- INSERT. Most tables in this schema use a single `FOR ALL USING (is_admin())`
-- policy; this one splits it because an INSERT here is token minting — an admin
-- could write a hash of their own choosing and grant themselves a working
-- connector token for any agent. Issuance goes through the service role only.
CREATE POLICY "connector_tokens_admin_read" ON connector_tokens
  FOR SELECT USING (public.is_admin());

CREATE POLICY "connector_tokens_admin_revoke" ON connector_tokens
  FOR UPDATE USING (public.is_admin());

CREATE POLICY "connector_tokens_admin_delete" ON connector_tokens
  FOR DELETE USING (public.is_admin());
