-- Roles-and-permissions Phase 3b — ownership carries read access (GAP-15 /
-- DEC-7) and the document_versions integrity overlay (EGRESS-6).
--
--   · GAP-15/DEC-7 — 20260630 promised the owner "is granted CRUD access to
--     their scope"; the WRITE half shipped (publish guard) and the READ half
--     never did: a non-controller owner of a private library cannot open
--     their own documents, and isEffectiveOwnerOfDocument (reading under the
--     caller's RLS) tells them they are not the owner. Per DEC-7 the fix is
--     an ownership branch INSIDE node_visible — after the controller
--     short-circuit, before the acl_index check — never an auto-granted ACL
--     rule at assignment time (that adds a second dependent write to
--     setOwner, the known silent-failure site). node_visible gains a 6-arg
--     form carrying the owner cascade columns; the 3-arg form remains as a
--     delegating wrapper for callers with no owner (document_sets).
--   · EGRESS-6 — document_versions had a SELECT overlay and a DELETE overlay
--     but NO INSERT/UPDATE overlay: any active member could insert a version
--     row against any document or amend revision_label / file_url /
--     approved_by_name / released_at on any row. The overlay admits exactly
--     the mapped legitimate writers: publisher-grade writes (controller /
--     per-library publish grant / effective owner) for anything released;
--     an AUTHORSHIP arm for a member's own unreleased in-review draft and
--     for a document's FIRST version (the creation flows); and a narrow arm
--     so an external intake draft can be rejected without publish authority
--     but never released by one. Service-role paths and the SECURITY DEFINER
--     RPCs are unaffected. The app half (on the branch) made every silent
--     writer loud FIRST (Trap 2).
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

-- ── GAP-15/DEC-7: the ownership branch ──────────────────────────────────────
CREATE OR REPLACE FUNCTION node_visible(
  p_visibility text,
  p_acl_index  jsonb,
  p_org        uuid,
  p_owner      uuid,
  p_collection uuid,
  p_library    uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_teams text[];
BEGIN
  -- Fail-safe: normal/unset visibility is open to org members.
  IF p_visibility IS NULL OR p_visibility = 'normal' THEN
    RETURN true;
  END IF;

  -- Controllers always see everything.
  SELECT role INTO v_role FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN true;
  END IF;

  -- GAP-15/DEC-7: ownership carries read access. Placed after the controller
  -- short-circuit and before the acl_index check (the decision's ordering —
  -- an owner outranks a stray deny of their own document). The cascade
  -- (document → folder → library → team supervisor) is the same SECURITY
  -- DEFINER function the publish guard trusts, so no recursion.
  IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN
    RETURN true;
  END IF;

  -- Restricted with no grant table -> only controllers (already returned).
  IF p_acl_index IS NULL THEN
    RETURN false;
  END IF;

  -- Explicit deny of read/discover wins.
  IF (p_acl_index->'deny'->'users'->'read') ? v_uid
     OR (p_acl_index->'deny'->'users'->'discover') ? v_uid THEN
    RETURN false;
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid = auth.uid();

  -- Any allow grant (any action) lets the row through; finer read-vs-
  -- discover distinctions stay in the app layer.
  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams);
END;
$$;

-- The 3-arg form stays for owner-less callers (document_sets), delegating so
-- there is exactly ONE body to maintain.
CREATE OR REPLACE FUNCTION node_visible(
  p_visibility text,
  p_acl_index  jsonb,
  p_org        uuid
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT node_visible(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid);
$$;

-- doc_is_visible forwards the owner cascade — this is the path that gates
-- document_versions SELECT (and with it file_url, the storage key).
CREATE OR REPLACE FUNCTION doc_is_visible(p_doc uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT node_visible(d.visibility, d.acl_index, d.org_id,
                         d.owner_user_id, d.collection_id, d.library_id)
       FROM documents d WHERE d.id = p_doc),
    false);
$$;

-- Re-create the two direct SELECT overlays with the owner columns.
DROP POLICY IF EXISTS documents_acl_select ON documents;
CREATE POLICY documents_acl_select ON documents AS RESTRICTIVE FOR SELECT
  USING (node_visible(visibility, acl_index, org_id, owner_user_id, collection_id, library_id));

DROP POLICY IF EXISTS collections_acl_select ON collections;
CREATE POLICY collections_acl_select ON collections AS RESTRICTIVE FOR SELECT
  USING (node_visible(visibility, acl_index, org_id, owner_user_id, NULL, library_id));

-- document_shares_insert (20261026 body, byte-carried) with the 6-arg call —
-- an owner may share what they can now read.
DROP POLICY IF EXISTS document_shares_insert ON document_shares;
CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (
  document_shares.created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_shares.document_id
      AND d.org_id = document_shares.org_id
      AND node_visible(d.visibility, d.acl_index, d.org_id,
                       d.owner_user_id, d.collection_id, d.library_id)
  )
);

-- ── EGRESS-6: the document_versions integrity overlay ───────────────────────
-- One place computes "may this caller make publisher-grade writes to this
-- document's versions": controller, per-library publish grant, or effective
-- owner — the same three arms as the publish guard and publish_revision.
CREATE OR REPLACE FUNCTION user_can_publish_doc(p_doc uuid, p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_org_controller(p_org)
      OR COALESCE(
           (SELECT user_can_publish_on_library(d.library_id, auth.uid()::text, p_org)
                OR user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
              FROM documents d WHERE d.id = p_doc),
           false);
$$;

-- INSERT: publisher-grade for anything, OR the author's own row when it is
-- either an unreleased in-review draft (submit-for-review) or the document's
-- FIRST version (the creation flows: upload-and-link, bulk upload,
-- split/merge targets). A released-looking row against a document with
-- history requires publish authority — the exact EGRESS-6 hole.
DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;
CREATE POLICY document_versions_insert_integrity ON document_versions
AS RESTRICTIVE FOR INSERT WITH CHECK (
  user_can_publish_doc(record_id, org_id)
  OR (
    created_by = auth.uid()
    AND doc_is_visible(record_id)
    AND (
      (review_state = 'in_review' AND released_at IS NULL)
      OR NOT EXISTS (SELECT 1 FROM document_versions v2
                     WHERE v2.record_id = document_versions.record_id)
    )
  )
);

-- UPDATE: publisher-grade; OR the author amending their OWN still-in-review
-- draft (retiring a race loser, resubmitting) which can never leave review
-- through this arm; OR the narrow external-intake arm — an in-review
-- external submission may be marked rejected (project triage) but never
-- released without publish authority.
DROP POLICY IF EXISTS document_versions_update_integrity ON document_versions;
CREATE POLICY document_versions_update_integrity ON document_versions
AS RESTRICTIVE FOR UPDATE
USING (
  user_can_publish_doc(record_id, org_id)
  OR (created_by = auth.uid() AND review_state = 'in_review')
  OR (review_state = 'in_review' AND provenance = 'external' AND intake_link_id IS NOT NULL)
)
WITH CHECK (
  user_can_publish_doc(record_id, org_id)
  OR (created_by = auth.uid() AND review_state = 'in_review' AND released_at IS NULL)
  OR (review_state IN ('in_review', 'rejected') AND provenance = 'external'
      AND intake_link_id IS NOT NULL AND released_at IS NULL)
);

COMMIT;

-- ── Verification (read-only) — expect true × 7 ──────────────────────────────
SELECT 'node_visible has the 6-arg ownership form' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6) AS ok
UNION ALL
SELECT 'ownership branch present in the 6-arg body',
       (SELECT prosrc LIKE '%user_is_effective_owner(p_owner, p_collection, p_library%'
          FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6)
UNION ALL
SELECT 'doc_is_visible forwards the owner cascade',
       (SELECT prosrc LIKE '%d.owner_user_id, d.collection_id, d.library_id%'
          FROM pg_proc WHERE proname = 'doc_is_visible')
UNION ALL
SELECT 'documents SELECT overlay passes owner columns',
       (SELECT qual LIKE '%owner_user_id%' FROM pg_policies
         WHERE tablename = 'documents' AND policyname = 'documents_acl_select')
UNION ALL
SELECT 'document_versions INSERT overlay installed (restrictive)',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_versions'
                AND policyname = 'document_versions_insert_integrity' AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'document_versions UPDATE overlay installed (restrictive)',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_versions'
                AND policyname = 'document_versions_update_integrity' AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'search_path pinned on both node_visible forms + helpers',
       (SELECT COUNT(*) = 4 FROM pg_proc
         WHERE ((proname = 'node_visible' AND pronargs IN (3, 6))
                OR proname IN ('doc_is_visible', 'user_can_publish_doc'))
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, paste back) — expect 0:
-- in-review rows with NO author and NO external provenance would be
-- amendable only by publishers after the overlay; a non-zero count means
-- orphan drafts to look at (not a blocker — publishers can still manage them).
SELECT 'authorless non-external in-review drafts' AS inventory, COUNT(*)::text AS n
FROM document_versions
WHERE review_state = 'in_review'
  AND created_by IS NULL
  AND (provenance IS DISTINCT FROM 'external' OR intake_link_id IS NULL);
