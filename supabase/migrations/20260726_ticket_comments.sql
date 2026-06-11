-- 20260726_ticket_comments.sql
-- Comments become a real, queryable table — and comment posting becomes ATOMIC.
--
-- Why: today comments live only as a JSONB array on the tickets row, written
-- read-modify-write from the client. Two people commenting at the same moment
-- last-write-wins the whole array — a lost comment. This migration:
--
--   1. creates ticket_comments (one row per comment — queryable, indexable,
--      per-comment audit trail),
--   2. adds post_ticket_comment(): a single-transaction RPC that inserts the
--      row AND appends to the legacy JSONB via `comments || $1` — an atomic
--      in-database append, so concurrent comments can never clobber each other,
--   3. keeps the JSONB array fully populated (dual-write) so every existing
--      reader (ticket page, realtime, exports) works unchanged. Reads flip to
--      the table in a later, separate change.
--
-- Additive + idempotent. Reversible: DROP FUNCTION post_ticket_comment;
-- DROP TABLE ticket_comments;  (the JSONB path keeps working regardless)

CREATE TABLE IF NOT EXISTS ticket_comments (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_uid UUID NOT NULL,
  author_email TEXT,
  author_role TEXT,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'General',
  category TEXT,
  mentioned_uids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx ON ticket_comments(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_comments_org_idx ON ticket_comments(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_comments_author_idx ON ticket_comments(author_uid);

ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;

-- Active org members can read their org's comments.
DROP POLICY IF EXISTS ticket_comments_org_select ON ticket_comments;
CREATE POLICY ticket_comments_org_select ON ticket_comments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.org_id = ticket_comments.org_id
      AND org_members.uid = auth.uid()
      AND org_members.status = 'active'
  )
);
-- Writes go through the SECURITY DEFINER RPC / service role only — no direct
-- client INSERT/UPDATE/DELETE policies on purpose.

-- Atomic comment post: one transaction inserts the row and appends to the
-- legacy JSONB (atomic `||` append — no read-modify-write race), bumps
-- unread/watchers/last_modified. Caller must be an active member of the
-- ticket's org (checked explicitly because SECURITY DEFINER bypasses RLS).
CREATE OR REPLACE FUNCTION post_ticket_comment(
  p_ticket_id UUID,
  p_comment   JSONB,
  p_unread    UUID[],
  p_watchers  UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org UUID;
BEGIN
  SELECT org_id INTO v_org FROM tickets WHERE id = p_ticket_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_org AND uid = auth.uid() AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'not an active member of this org';
  END IF;

  INSERT INTO ticket_comments (id, org_id, ticket_id, author_uid, author_email, author_role, body, type, category, mentioned_uids, created_at)
  VALUES (
    COALESCE((p_comment->>'id')::uuid, gen_random_uuid()),
    v_org,
    p_ticket_id,
    COALESCE((p_comment->>'authorUid')::uuid, auth.uid()),
    p_comment->>'user',
    p_comment->>'role',
    COALESCE(p_comment->>'text', ''),
    COALESCE(p_comment->>'type', 'General'),
    p_comment->>'category',
    COALESCE(
      (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_comment->'mentionedUserIds', '[]'::jsonb)) AS x),
      '{}'::uuid[]
    ),
    COALESCE((p_comment->>'date')::timestamptz, NOW())
  );

  UPDATE tickets
     SET comments      = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(p_comment),
         unread_by     = COALESCE(p_unread, unread_by),
         watchers      = COALESCE(p_watchers, watchers),
         last_modified = NOW()
   WHERE id = p_ticket_id;
END$$;

GRANT EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) TO authenticated, service_role;
