-- OAuth 2.1 refresh tokens for the claude.ai connector (OAuth 7).
--
-- Until now an OAuth grant was a single 30-day access token and nothing else:
-- when it expired the connector simply stopped answering and a human had to
-- re-consent in a browser. That is a silent failure — the grant issued on
-- 2026-08-08 died on 2026-09-07 and nobody noticed for two weeks.
--
-- A refresh token lets the client obtain a new access token without a person
-- involved. Rules, all of which the token endpoint enforces:
--
--   * ROTATION. OAuth 2.1 requires it for public clients, and claude.ai is a
--     public client (registered via DCR, no secret). Every use consumes the
--     presented token and issues a new one.
--   * FAMILIES. Every rotation of one consent shares a family_id. Presenting a
--     token that was already consumed means it leaked and someone replayed it,
--     so the whole family is revoked — not merely the one request refused.
--   * HASHED AT REST, like every other secret in this schema. The plaintext
--     exists for one response.
--   * SLIDING LIFETIME. Each rotation extends the grant; a grant unused for the
--     refresh lifetime (90 days) dies and needs consent again.
--
-- A separate table rather than more columns on connector_tokens: the two are
-- different credentials with different lifetimes, and a refresh token must
-- never be accepted where an access token is (or the reverse). Keeping them
-- apart makes that structural — /api/mcp never reads this table.

CREATE TABLE oauth_refresh_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       text NOT NULL UNIQUE,
  -- All rotations descending from one consent. Reuse detection revokes by this.
  family_id        uuid NOT NULL,
  client_id        text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The consenting Supabase user, carried from the authorization code.
  user_id          uuid NOT NULL,
  scope            text NOT NULL DEFAULT 'read'
                     CHECK (scope IN ('read', 'read-write')),
  -- RFC 8707 audience, copied onto every access token this grant issues. Never
  -- null: an OAuth grant must always name the resource it was issued for.
  audience         text NOT NULL,
  -- The access token issued alongside this refresh token. Revoked when the
  -- refresh token is rotated (one live access token per grant) and consulted
  -- on refresh: revoking an access token from the dashboard or CLI also ends
  -- the grant, so revocation stays a single action.
  access_token_id  uuid REFERENCES connector_tokens(id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  -- Set on rotation. A token that already has this is being replayed.
  consumed_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The refresh grant looks up by hash; only unconsumed, unrevoked rows are live.
CREATE INDEX idx_oauth_refresh_tokens_hash
  ON oauth_refresh_tokens(token_hash)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Reuse detection revokes a family in one statement.
CREATE INDEX idx_oauth_refresh_tokens_family ON oauth_refresh_tokens(family_id);

CREATE INDEX idx_oauth_refresh_tokens_agent ON oauth_refresh_tokens(agent_id);

COMMENT ON TABLE oauth_refresh_tokens IS
  'OAuth 2.1 refresh tokens for the claude.ai connector. Rotated on every use; a replayed token revokes its whole family. Hashed at rest. Read only by /api/oauth/token.';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Credential material: only the service role touches this table, and it
-- bypasses RLS. Admins may read for support and revoke, and may not insert —
-- an insert here is minting a grant. Same split as connector_tokens.

ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oauth_refresh_tokens_admin_read" ON oauth_refresh_tokens
  FOR SELECT USING (public.is_admin());

CREATE POLICY "oauth_refresh_tokens_admin_revoke" ON oauth_refresh_tokens
  FOR UPDATE USING (public.is_admin());
