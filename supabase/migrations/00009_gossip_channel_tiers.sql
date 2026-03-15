-- Migration 00009: Gossip Layer Phase 1 — Channel Tiers
--
-- Adds 'shared' and 'gossip' channel types with federation_scope column.
-- Three-tier model:
--   private (local)   — default, no federation
--   shared-* (peers)  — syncs with direct peers only
--   gossip-* (global) — syncs with full network via supernodes

-- 1. Extend channel_type enum with new values
ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'shared';
ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'gossip';

-- 2. Add federation_scope column
-- Must be a text column (not enum) because CHECK constraints with enums
-- across two columns are fragile with ALTER TYPE.
ALTER TABLE channels ADD COLUMN federation_scope text NOT NULL DEFAULT 'local';

-- 3. Add CHECK constraint: federation_scope must be valid
ALTER TABLE channels ADD CONSTRAINT channels_federation_scope_valid
  CHECK (federation_scope IN ('local', 'peers', 'global'));

-- 4. Add CHECK constraint: federation_scope must match channel type
-- Only shared channels can have 'peers' scope, only gossip channels can have 'global' scope
ALTER TABLE channels ADD CONSTRAINT channels_federation_scope_matches_type
  CHECK (
    (federation_scope = 'local') OR
    (federation_scope = 'peers' AND type = 'shared') OR
    (federation_scope = 'global' AND type = 'gossip')
  );

-- 5. Index for federation queries (sync endpoints will filter on this)
CREATE INDEX idx_channels_federation_scope ON channels(federation_scope)
  WHERE federation_scope != 'local';

-- 6. Backfill: all existing channels are local (already the default, but explicit)
-- No-op since DEFAULT 'local' handles it, but included for clarity
UPDATE channels SET federation_scope = 'local' WHERE federation_scope = 'local';
