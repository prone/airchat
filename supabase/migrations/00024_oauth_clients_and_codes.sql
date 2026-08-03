-- OAuth 2.1 authorization server: registered clients and authorization codes.
--
-- claude.ai has no static-bearer path. It probes for OAuth metadata and, on
-- finding none, fails outright — proven by the spike on 2026-08-02, and matching
-- anthropics/claude-ai-mcp#112 (closed NOT_PLANNED) and #10 (open since
-- January). So this server has to issue tokens rather than accept minted ones.
--
-- Access tokens themselves reuse connector_tokens. That table already hashes
-- its secrets, carries scope, expiry, revocation and last_used_at, and binds to
-- a credential-less agent that cannot authenticate to /api/v2. Adding a second
-- token store would duplicate all of that and let the two drift.

-- ── Registered clients (RFC 7591) ──────────────────────────────────────────
--
-- Registration is unauthenticated by design: a client that has never seen this
-- server must be able to obtain an id before any user is involved. That makes
-- this the one publicly writable table in the schema, so it is deliberately
-- cheap to hold and easy to prune — no secrets for public clients, and a
-- created_at to age rows out.

CREATE TABLE oauth_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL UNIQUE,
  -- Null for public clients, which is what claude.ai is: it cannot hold a
  -- secret, which is exactly why PKCE is mandatory rather than optional here.
  client_secret_hash  text,
  client_name         text,
  -- Exact-match set. RFC 6749 §3.1.2.3 and the MCP spec both require exact
  -- comparison; prefix or wildcard matching is how open-redirect bugs happen.
  redirect_uris       text[] NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz
);

CREATE INDEX idx_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX idx_oauth_clients_created_at ON oauth_clients(created_at);

COMMENT ON TABLE oauth_clients IS
  'RFC 7591 dynamically registered OAuth clients. Publicly writable by design — registration precedes any user interaction. Rate limited at the route.';

-- ── Authorization codes ────────────────────────────────────────────────────
--
-- Short-lived, single-use, and stored hashed like every other secret here.
-- The PKCE challenge is bound to the code at issue time and verified at
-- exchange, which is what stops an intercepted code being redeemed by anyone
-- other than the client that requested it.

CREATE TABLE oauth_authorization_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           text NOT NULL UNIQUE,
  client_id           text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  -- The Supabase user who consented. Admin-only for now: see the OAuth 3
  -- decision. Recorded so a token can be traced back to a person.
  user_id             uuid NOT NULL,
  -- The connector agent this grant will act as, resolved at consent time.
  agent_id            uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  redirect_uri        text NOT NULL,
  scope               text NOT NULL DEFAULT 'read'
                        CHECK (scope IN ('read', 'read-write')),
  -- RFC 8707: the resource the token is being requested for. Carried through
  -- to the access token as its audience.
  resource            text,
  code_challenge      text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256'
                        CHECK (code_challenge_method = 'S256'),
  expires_at          timestamptz NOT NULL,
  -- Set on exchange. A code that already has this is replayed, not valid.
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_codes_hash ON oauth_authorization_codes(code_hash)
  WHERE consumed_at IS NULL;
CREATE INDEX idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);

COMMENT ON TABLE oauth_authorization_codes IS
  'Short-lived single-use authorization codes with a bound PKCE challenge. Hashed at rest like every other secret in this schema.';

-- ── Access tokens: extend connector_tokens rather than duplicating it ──────

ALTER TABLE connector_tokens
  ADD COLUMN client_id text REFERENCES oauth_clients(client_id) ON DELETE SET NULL,
  -- The audience. The MCP spec requires a server to reject tokens not issued
  -- for it, three separate times, and calls failure here a confused-deputy
  -- vulnerability. Null for CLI-issued tokens, which are audience-bound
  -- structurally instead: nothing outside /api/mcp reads this table.
  ADD COLUMN audience text,
  -- The consenting Supabase user, for OAuth-issued tokens.
  ADD COLUMN granted_by_user_id uuid;

COMMENT ON COLUMN connector_tokens.audience IS
  'Canonical URI this token was issued for (RFC 8707). Validated on every request. Null means CLI-issued, where audience binding is structural.';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Both tables hold credentials or credential material. Only the service role
-- touches them, and it bypasses RLS — so RLS is on with no permissive policy,
-- matching connector_tokens. Admins may read for support, and may not insert:
-- writing a row here is minting a grant.

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oauth_clients_admin_read" ON oauth_clients
  FOR SELECT USING (public.is_admin());

CREATE POLICY "oauth_codes_admin_read" ON oauth_authorization_codes
  FOR SELECT USING (public.is_admin());
