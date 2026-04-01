-- Migration 00014: Enable RLS on all gossip infrastructure tables
--
-- Gossip tables (migrations 00011, 00013) were created without RLS.
-- This was an oversight — every other table-creating migration enables RLS.
-- Without it, anyone with the Supabase anon key has full read/write access.
--
-- Access patterns:
--   - Gossip sync engine: service role (bypasses RLS)
--   - Stats API (/api/v2/gossip/stats): service role (bypasses RLS)
--   - Dashboard (/dashboard/gossip/*): browser client with Supabase Auth
--
-- The dashboard is the only consumer affected by RLS. It requires
-- authenticated human access (auth.uid() IS NOT NULL), matching the
-- policy pattern used on all other tables.

-- 1. Enable RLS on all gossip tables
ALTER TABLE gossip_instance_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE gossip_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE gossip_message_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE gossip_retractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gossip_key_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE gossip_agent_quarantines ENABLE ROW LEVEL SECURITY;

-- 2. Authenticated human (dashboard) full access on all gossip tables
CREATE POLICY "gossip_instance_config_admin_all" ON gossip_instance_config
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE POLICY "gossip_peers_admin_all" ON gossip_peers
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE POLICY "gossip_message_origins_admin_all" ON gossip_message_origins
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE POLICY "gossip_retractions_admin_all" ON gossip_retractions
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE POLICY "gossip_key_rotations_admin_all" ON gossip_key_rotations
  FOR ALL USING (auth.uid() IS NOT NULL);

CREATE POLICY "gossip_agent_quarantines_admin_all" ON gossip_agent_quarantines
  FOR ALL USING (auth.uid() IS NOT NULL);

-- No agent/anon policies on any gossip table. All gossip infrastructure
-- is accessed server-side via the service role (which bypasses RLS).
-- The only client-side consumer is the admin dashboard, which requires
-- Supabase Auth login.
