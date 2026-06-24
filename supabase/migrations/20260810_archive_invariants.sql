-- 20260810_archive_invariants.sql
-- Make "an archived stub is immutable" a database-level invariant, and index the
-- closed-ticket archival hot path. Additive + idempotent; safe on a live DB.
--
-- WHY: archival clears a ticket's comment/history JSONB and deletes its
-- ticket_comments rows, leaving a lightweight stub (archived_at set). If ANY
-- write path repopulates that content while archived_at stays set, the stub
-- diverges from its saved archive and a later restore destroys the interim edit.
-- The API routes now reject writes to archived tickets, but post_ticket_comment
-- is SECURITY DEFINER and callable directly, so the guard belongs in the DB too.

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
DECLARE
  v_org      UUID;
  v_archived TIMESTAMPTZ;
BEGIN
  SELECT org_id, archived_at INTO v_org, v_archived FROM tickets WHERE id = p_ticket_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'ticket is archived; restore it before commenting';
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

-- Hot path for the closed-ticket archive preview/produce and the active-ticket
-- list: both filter by (org_id, status) and order by last_modified. The earlier
-- migration only indexed archived stubs (archived_at IS NOT NULL) — the opposite
-- of what produce scans. This covers the un-archived population.
CREATE INDEX IF NOT EXISTS tickets_org_status_modified_idx
  ON tickets(org_id, status, last_modified);
