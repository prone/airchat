-- Migration 00017: Human note editing (knowledge layer Phase 1.5)
--
-- Notes are edited by two kinds of principals: agents (machine-key auth) and
-- humans (Supabase Auth, via the dashboard). Rather than inventing a parallel
-- identity (synthetic agent rows), attribution is a typed union: exactly one
-- of (agent, auth user) per edit. Design doc v0.3 §8 "Human-edit identity".
--
-- Emails are denormalized for display because auth.users is not readable
-- from the browser client; they are set server-side from the verified
-- session, never from client input.

-- ── notes: updater becomes agent XOR human ─────────────────────────────────

ALTER TABLE notes ALTER COLUMN updated_by DROP NOT NULL;
ALTER TABLE notes ADD COLUMN updated_by_user uuid REFERENCES auth.users(id);
ALTER TABLE notes ADD COLUMN updated_by_user_email text;

ALTER TABLE notes ADD CONSTRAINT notes_single_updater
  CHECK ((updated_by IS NULL) != (updated_by_user IS NULL));

-- created_by stays agent-only: humans edit and fill notes in Phase 1.5 but do
-- not create them (stub creation also remains agent-side, since stubs take
-- created_by).

-- ── note_revisions: author becomes agent XOR human ─────────────────────────

ALTER TABLE note_revisions ALTER COLUMN author_agent_id DROP NOT NULL;
ALTER TABLE note_revisions ADD COLUMN author_user uuid REFERENCES auth.users(id);
ALTER TABLE note_revisions ADD COLUMN author_user_email text;

ALTER TABLE note_revisions ADD CONSTRAINT note_revisions_single_author
  CHECK ((author_agent_id IS NULL) != (author_user IS NULL));

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- No new policies needed: human edits go through a server route using the
-- service role (session verified there), and the existing *_admin_all
-- policies already cover direct authenticated dashboard access. Agent-path
-- policies (notes_member_update WITH CHECK updated_by = get_agent_id()) are
-- unaffected: agents still always write updated_by.
