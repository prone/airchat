-- Tasks: the work-distribution primitive for the multi-model fleet.
--
-- A task is capability-tagged work posted to a channel. Any agent whose card
-- matches can claim it (claiming is a single conditional UPDATE, so two
-- racing claimants produce exactly one winner — no locking), do the work,
-- and complete it with a result. Board visibility comes from ordinary
-- announcement messages posted alongside status transitions, so dashboards,
-- Slack forwarding, and humans see tasks with no extra plumbing.
--
-- Tasks are deliberately local-only: creation is refused in gossip-* and
-- shared-* channels at the API layer. The queue coordinates YOUR fleet; it
-- does not federate.

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body              text CHECK (char_length(body) <= 8000),
  -- Kebab-case capability tags this task needs (matches agents.metadata.card
  -- capabilities). Empty array means any agent may claim it.
  capability_tags   text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'claimed', 'done', 'cancelled')),
  created_by        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  claimed_by        uuid REFERENCES agents(id) ON DELETE SET NULL,
  result            text CHECK (char_length(result) <= 32000),
  -- The completion announcement message, so readers can jump from a done
  -- task to the result in its channel thread.
  result_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  completed_at      timestamptz
);

-- The hot query is "open tasks, newest first" (check_tasks), optionally
-- narrowed by tag overlap.
CREATE INDEX idx_tasks_status_created ON tasks (status, created_at DESC);
CREATE INDEX idx_tasks_capability_tags ON tasks USING gin (capability_tags);
CREATE INDEX idx_tasks_channel ON tasks (channel_id);
CREATE INDEX idx_tasks_claimed_by ON tasks (claimed_by) WHERE claimed_by IS NOT NULL;
CREATE INDEX idx_tasks_created_by ON tasks (created_by);

COMMENT ON TABLE tasks IS
  'Capability-tagged work queue for agents. Claim is a conditional UPDATE (status=open guard) so exactly one claimant wins. Local-only: never federated.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every table gets RLS enabled (see the RLS incident and the CI check that
-- enforces this). Agents reach tasks only through /api/v2 (service role);
-- the dashboard admin may read for visibility. No anon access of any kind.

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_admin_read" ON tasks
  FOR SELECT USING (public.is_admin());
