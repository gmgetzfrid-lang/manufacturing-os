-- 20260729_checkout_episodes.sql
--
-- CHECKOUT EPISODES — make the checkout a first-class "ticket".
--
-- Problem this fixes: checkout_messages were document-scoped (a deliberate
-- 20260620 decision), so a brand-new checkout showed every comment from every
-- previous checkout. There was also no grouping record, so "the checkout"
-- existed only implicitly and ended whenever the LOCK HOLDER checked in, even
-- if collaborators still had active sessions.
--
-- New model:
--   * The first checkout on an idle document OPENS an episode (Checkout #N).
--   * Anyone who checks out while the episode is live JOINS that episode.
--   * Messages and sessions carry episode_id — the live thread shows only the
--     current episode; closed episodes are sealed, browsable records.
--   * The episode CLOSES only when the last active session ends (check-in,
--     force release, or auto-expiry). The next checkout opens a fresh episode
--     with an empty thread.
--
-- Pre-existing rows keep episode_id = NULL; the UI groups them under a single
-- "Earlier activity" history bucket. No data is rewritten.
--
-- Additive + idempotent. Apply manually in the Supabase SQL editor, like the
-- rest of the migrations.

-- ─── Episode table ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checkout_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  -- Per-document running number ("Checkout #3"). Uniqueness is guaranteed by
  -- the one-active-per-document index below: a new episode can only be created
  -- while no other is active, so MAX(seq)+1 cannot race with itself.
  seq INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TEXT (not UUID): system actors ("system") close episodes via the
  -- auto-expiry sweep, same convention as checkout_messages.user_id.
  opened_by TEXT,
  opened_by_name TEXT,
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  closed_by_name TEXT,
  close_reason TEXT  -- 'checked_in' | 'force_released' | 'expired' | 'reconciled'
);

-- THE core invariant: at most one live episode per document, enforced by the
-- database, not the client. Concurrent "first checkouts" race here — the loser
-- gets a unique violation and re-selects the winner's episode (= joins it).
CREATE UNIQUE INDEX IF NOT EXISTS checkout_episodes_one_active_per_document
  ON checkout_episodes(document_id) WHERE (status = 'active');

CREATE INDEX IF NOT EXISTS checkout_episodes_doc_idx
  ON checkout_episodes(document_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS checkout_episodes_org_idx
  ON checkout_episodes(org_id, status);

-- ─── Link sessions + messages to their episode ────────────────────────────
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES checkout_episodes(id) ON DELETE SET NULL;
ALTER TABLE checkout_messages
  ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES checkout_episodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS checkout_sessions_episode_idx
  ON checkout_sessions(episode_id);
CREATE INDEX IF NOT EXISTS checkout_messages_episode_idx
  ON checkout_messages(episode_id, created_at);

-- ─── RLS — same active-org-member rule as the other collab tables ─────────
ALTER TABLE checkout_episodes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkout_episodes_org_select ON checkout_episodes;
CREATE POLICY checkout_episodes_org_select ON checkout_episodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_episodes.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS checkout_episodes_org_insert ON checkout_episodes;
CREATE POLICY checkout_episodes_org_insert ON checkout_episodes FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_episodes.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- Any active org member may update (close/transfer bookkeeping): check-in by a
-- collaborator, admin force-release, and the maintenance sweep all legitimately
-- close an episode someone else opened.
DROP POLICY IF EXISTS checkout_episodes_org_update ON checkout_episodes;
CREATE POLICY checkout_episodes_org_update ON checkout_episodes FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_episodes.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- ─── Realtime — the checkout modal listens for open/close transitions ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'checkout_episodes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE checkout_episodes;
  END IF;
END$$;

ALTER TABLE checkout_episodes REPLICA IDENTITY FULL;

COMMENT ON TABLE checkout_episodes IS
  'One row per checkout "ticket": opened by the first checkout on an idle document, joined by concurrent checkouts, closed when the last active session ends. Messages and sessions reference it via episode_id; the live thread is episode-scoped and closed episodes are sealed history.';
COMMENT ON COLUMN checkout_episodes.seq IS
  'Per-document running number for display ("Checkout #3").';
COMMENT ON COLUMN checkout_episodes.close_reason IS
  'checked_in = last participant checked in; force_released = admin override; expired = auto-release sweep; reconciled = state repair closed a stray episode.';
