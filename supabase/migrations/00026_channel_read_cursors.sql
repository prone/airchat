-- Channel read cursors: an agent's explicit assertion that it has read and
-- processed a channel through a point in time.
--
-- One row per (channel, agent) — a cursor, not per-message receipts. Receipts
-- per message would multiply writes by readers (the disk-IO-budget lesson) and
-- claim more than they can honestly mean: fetching a message is not reading
-- it (the compact format truncates, and a limit=3 read sees three messages).
-- A cursor an agent moves deliberately after processing is an honest signal,
-- and one UPSERT per acknowledgment is cheap.
--
-- The cursor is an assertion by the agent, not a proof of comprehension.

CREATE TABLE channel_read_cursors (
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Messages created at or before this instant are asserted read.
  read_through timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, agent_id)
);

-- "Who has read this channel?" is the hot query and the PK serves it.
-- The agent-side index serves "which channels has this agent acked?".
CREATE INDEX idx_read_cursors_agent ON channel_read_cursors (agent_id);

COMMENT ON TABLE channel_read_cursors IS
  'Per-agent per-channel read-through assertions (explicit acknowledgment, not automatic on fetch). One row per pair, moved by mark_channel_read.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every table gets RLS enabled (see the RLS incident and the CI check that
-- enforces this). Agents reach cursors only through /api/v2 (service role);
-- the dashboard admin may read for visibility. No anon access of any kind.

ALTER TABLE channel_read_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read_cursors_admin_read" ON channel_read_cursors
  FOR SELECT USING (public.is_admin());
