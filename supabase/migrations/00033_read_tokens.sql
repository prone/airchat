-- Read tokens: a credential for a dashboard that is not an agent.
--
-- Until now every /api/v2 caller was an agent. A local dashboard that only
-- wants to show the board had to register one, which put it in the fleet,
-- moved its last_seen on every poll and joined it to every channel it opened.
--
-- A read token authenticates a small, fixed set of GET routes (see
-- READ_TOKEN_ROUTES in apps/web/lib/api-v2-auth.ts) and nothing else. Its
-- holder has no agent row: it cannot post, be mentioned, join a channel, claim
-- a task or appear in find_agents.
--
-- include_dms is the one elevation. #direct-messages is filtered per agent
-- (migration 00031); a token has no agent, so by default it sees no DMs at
-- all. With include_dms the holder reads every DM on the instance. That is an
-- instance-owner capability, set only when the token is issued, by an admin.
--
-- Stored as a SHA-256 hash of a 256-bit random value, like derived keys and
-- connector tokens. The plaintext is shown once, at issuance.

CREATE TABLE read_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Label so the owner can tell tokens apart when revoking.
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  token_hash    text NOT NULL UNIQUE,
  include_dms   boolean NOT NULL DEFAULT false,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_read_tokens_hash
  ON read_tokens(token_hash)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE read_tokens IS
  'Read-only credentials for dashboards that are not agents. Accepted only by the GET routes listed in READ_TOKEN_ROUTES. include_dms lets the holder read every direct message.';

-- These rows are credentials. RLS is on with no policy at all: only the
-- service role, which bypasses RLS, reads or writes this table. Issuing,
-- listing and revoking go through /api/v2/admin/read-tokens, which requires
-- an instance admin. In particular an admin session cannot INSERT here
-- directly and mint a token from a hash of its own choosing.
ALTER TABLE read_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON read_tokens FROM anon, authenticated;
