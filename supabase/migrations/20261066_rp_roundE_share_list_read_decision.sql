-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — EGRESS-8: listing a document's share links
-- requires being able to read the document.
--
-- The 20261022 SELECT policy on document_shares admitted any active member of
-- the row's org, with no document-read decision. A member denied read on a
-- restricted drawing could therefore enumerate its LIVE share tokens through
-- PostgREST and fetch /api/share/file?token=… — an intra-org parallel to
-- EGRESS-1. The INSERT policy (20261037) already asks "can the caller read
-- this document" through node_visible; this migration asks the same question
-- on SELECT.
--
-- Shape: active member of the row's org AND (the share's CREATOR, OR the
-- document is readable to the caller). The creator arm is deliberate: a
-- creator must still see — and so revoke — a share on a document they have
-- since lost read access to (20261026's rationale: that is the share that
-- most needs revoking). The token it exposes is one they minted, and it no
-- longer serves: /api/share/resolve and /api/share/file re-check the
-- creator's CURRENT authority before serving. The org join inside the EXISTS
-- is load-bearing (node_visible returns TRUE for normal/NULL visibility with
-- no org check — 20261022's note); the read-decision block is byte-carried
-- from the 20261037 INSERT policy so the two verbs cannot drift apart.
--
-- NARROWS: strictly fewer rows are visible than before, so no pre-apply
-- inventory is required (DEC-2 applies to widening); the counts below are for
-- the record. App half: /api/share/list applies the same decision with the
-- service role and returns NO token to a caller who cannot read the document
-- (not even their own), and the share modal renders no link it cannot use.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP POLICY IF EXISTS document_shares_org_select ON document_shares;
CREATE POLICY document_shares_org_select ON document_shares FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
  AND (
    document_shares.created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_shares.document_id
        AND d.org_id = document_shares.org_id
        AND node_visible(d.visibility, d.acl_index, d.org_id,
                         d.owner_user_id, d.collection_id, d.library_id)
    )
  )
);

COMMENT ON POLICY document_shares_org_select ON document_shares IS
  'EGRESS-8: listing a document''s share links requires reading the document (node_visible); a creator always sees their own rows so they can revoke them.';

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows are aggregate counts
--    only (n), never customer rows; the two 20261052 carry-over counts ride
--    here per the 2026-09-17 protocol note.
--    Probe 2 counts by cmd alone (no policyname): permissive policies OR
--    together, so a surviving permissive SELECT or FOR ALL policy — e.g.
--    20260623's document_shares_org_member if 20261022 was never applied —
--    would re-open the listing while this policy still exists. If probe 2 is
--    false, list the policies (SELECT policyname, cmd FROM pg_policies WHERE
--    tablename = 'document_shares') and apply 20261022 first.
SELECT 'document_shares_org_select exists (FOR SELECT)' AS check,
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'document_shares' AND cmd = 'SELECT'
           AND policyname = 'document_shares_org_select') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'it is the ONLY permissive policy admitting SELECT on document_shares (no other SELECT / FOR ALL policy to OR with it)',
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'document_shares' AND cmd IN ('SELECT', 'ALL')
           AND permissive = 'PERMISSIVE'),
       NULL
UNION ALL
SELECT 'SELECT applies the document-read decision, org-joined (node_visible, 6-arg)',
       (SELECT qual LIKE '%node_visible(d.visibility, d.acl_index, d.org_id, d.owner_user_id, d.collection_id, d.library_id)%'
           AND qual LIKE '%d.org_id = document_shares.org_id%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_org_select'),
       NULL
UNION ALL
SELECT 'SELECT keeps the active-membership term AND the creator arm',
       (SELECT qual LIKE '%m.status = ''active''%' AND qual LIKE '%created_by = auth.uid()%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_org_select'),
       NULL
UNION ALL
SELECT 'INSERT / UPDATE / DELETE policies untouched (20261037 / 20261026 / 20261022)',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE tablename = 'document_shares'
           AND policyname IN ('document_shares_insert', 'document_shares_update', 'document_shares_delete')),
       NULL
UNION ALL
SELECT 'inventory: share rows (all)', NULL,
       (SELECT COUNT(*) FROM document_shares)::text
UNION ALL
SELECT 'inventory: live share rows (unrevoked, unexpired)', NULL,
       (SELECT COUNT(*) FROM document_shares
         WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::text
UNION ALL
SELECT 'inventory: live share rows on restricted documents (visibility <> normal)', NULL,
       (SELECT COUNT(*) FROM document_shares s JOIN documents d ON d.id = s.document_id
         WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
           AND COALESCE(d.visibility, 'normal') <> 'normal')::text
UNION ALL
SELECT 'inventory (20261052 carry-over): stored capability policies', NULL,
       (SELECT COUNT(*) FROM org_configurations WHERE key = 'capability_policy')::text
UNION ALL
SELECT 'inventory (20261052 carry-over): rule-list entries already stored', NULL,
       (SELECT COUNT(*) FROM org_configurations c,
               jsonb_each(COALESCE(c.data->'caps', c.data)) e
         WHERE c.key = 'capability_policy'
           AND jsonb_typeof(e.value) = 'array'
           AND jsonb_array_length(e.value) > 0
           AND jsonb_typeof(e.value->0) = 'object')::text;
