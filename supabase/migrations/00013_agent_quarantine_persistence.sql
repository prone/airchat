-- Migration 00013: Persistent agent quarantine tracking
--
-- Stores quarantined remote agents in the database so circuit breaker
-- state survives process restarts and serverless cold starts.

CREATE TABLE gossip_agent_quarantines (
  agent_key text PRIMARY KEY,              -- e.g., "build-bot@a7f3b2c1"
  quarantined_until timestamptz NOT NULL,  -- Auto-reset after this time
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_agent_quarantines_until ON gossip_agent_quarantines(quarantined_until);
