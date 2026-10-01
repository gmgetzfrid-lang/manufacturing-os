-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P12 WAVE-2 RESIDUALS: the share INSERT
-- rail refuses a creator who is denied download on the document
-- (public-surfaces SHR-14).
--
--   SHR-14  document_shares_insert (20261080) admitted a mint when the caller
--           was an active member who could read the document, a controller
--           or a granted publisher of its library, and the document was
--           shareable — none of which reads acl_index.deny.*.download. A
--           publisher denied download on one document by uid, role or team
--           minted a row the routes then refused on every pull (since the
--           SHR-3 verification fix: creatorMayShare asks memberDownloadDenied
--           for the creator), so the link was dead while it looked live.
--           1. user_download_denied(p_acl_index, p_uid, p_org) — the SQL twin
--              of lib/downloadDeny.ts (downloadDeniedTo + memberDownloadDenied):
--              a deny names the uid, ANY role in the member's active role
--              collection (role + roles; an empty collection reads as
--              Viewer), or any team the uid is on; controllers are NOT
--              exempt. STABLE SECURITY DEFINER, search_path pinned. A
--              signed-in caller may ask only about themself (it reads a
--              member's roles and teams, so it is no oracle); the service
--              role (auth.uid() NULL) may ask about anyone, and anon may not
--              execute it at all (DRLS-16). A shape test pins it to the
--              TypeScript rule.
--           2. document_shares_insert re-created from its NEWEST body
--              (20261080, byte for byte — pinned by a lineDiff test) plus
--              one arm: NOT user_download_denied(d.acl_index, auth.uid(),
--              org) on the row's document.
--
-- NOT a widening: the policy refuses something it allowed. DEC-30 inventory
-- (aggregate counts, captured BEFORE the transaction; the predicate is
-- spelled out because it does not exist yet): live share rows whose creator
-- a download deny names by uid, by role or by team — they already answer
-- 410 (authority lapsed) at serve time and are kept for the record; revoke
-- them from Admin -> Share links (DIST-15) if wanted.
-- HOW TO APPLY: after 20261080 (the policy's base). Independent of
-- 20261139. Single paste: temp-table inventory -> BEGIN/DDL/COMMIT -> one
-- SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_140_before;
CREATE TEMP TABLE dc_round_f_140_before AS
SELECT 'inventory (before apply): live share rows (unrevoked, unexpired)' AS inventory, COUNT(*)::text AS n
  FROM document_shares s
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
UNION ALL
SELECT 'inventory (before apply): live share rows whose creator a download deny names by uid (SHR-14 - already refused at serve time)', COUNT(*)::text
  FROM document_shares s JOIN documents d ON d.id = s.document_id
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND jsonb_typeof(d.acl_index -> 'deny' -> 'users' -> 'download') = 'array'
   AND (d.acl_index -> 'deny' -> 'users' -> 'download') ? s.created_by::text
UNION ALL
SELECT 'inventory (before apply): live share rows whose creator a download deny names by a role in their collection (an empty collection read as Viewer)', COUNT(*)::text
  FROM document_shares s JOIN documents d ON d.id = s.document_id
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND jsonb_typeof(d.acl_index -> 'deny' -> 'roles' -> 'download') = 'array'
   AND EXISTS (
     SELECT 1
       FROM (SELECT COALESCE(NULLIF(ARRAY(SELECT DISTINCT r
                                            FROM unnest(COALESCE(m.roles, ARRAY[]::text[]) || m.role) AS r
                                           WHERE r IS NOT NULL AND btrim(r) <> ''), ARRAY[]::text[]),
                             ARRAY['Viewer']) AS held
               FROM (SELECT 1) AS one
               LEFT JOIN org_members m ON m.org_id = s.org_id AND m.uid = s.created_by AND m.status = 'active') AS c,
            unnest(c.held) AS r
      WHERE (d.acl_index -> 'deny' -> 'roles' -> 'download') ? r)
UNION ALL
SELECT 'inventory (before apply): live share rows whose creator a download deny names by team', COUNT(*)::text
  FROM document_shares s JOIN documents d ON d.id = s.document_id
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND jsonb_typeof(d.acl_index -> 'deny' -> 'teams' -> 'download') = 'array'
   AND EXISTS (SELECT 1 FROM team_members t
                WHERE t.uid = s.created_by AND (d.acl_index -> 'deny' -> 'teams' -> 'download') ? t.team_id::text);

BEGIN;

-- ── 1. The SQL twin of lib/downloadDeny.ts ──────────────────────────────────
CREATE OR REPLACE FUNCTION user_download_denied(p_acl_index jsonb, p_uid uuid, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deny  jsonb := p_acl_index -> 'deny';
  v_role  text;
  v_roles text[];
BEGIN
  -- A signed-in caller asks about THEMSELF only: the answer reads a member's
  -- roles and teams, so it must not be an oracle for anyone else's. The
  -- service role (auth.uid() NULL) may ask about anyone; anon is revoked.
  IF auth.uid() IS NOT NULL AND p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'user_download_denied answers only for the signed-in caller.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_deny) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  -- By uid.
  IF jsonb_typeof(v_deny -> 'users' -> 'download') = 'array'
     AND (v_deny -> 'users' -> 'download') ? p_uid::text THEN
    RETURN true;
  END IF;
  -- By ANY role in the active collection (CHAIN-1: a restriction binds
  -- whether or not a higher role sits above it); none reads as Viewer.
  SELECT m.role, m.roles INTO v_role, v_roles
    FROM org_members m
   WHERE m.org_id = p_org AND m.uid = p_uid AND m.status = 'active'
   LIMIT 1;
  v_roles := ARRAY(SELECT DISTINCT r FROM unnest(COALESCE(v_roles, ARRAY[]::text[]) || v_role) AS r
                    WHERE r IS NOT NULL AND btrim(r) <> '');
  IF cardinality(v_roles) = 0 THEN
    v_roles := ARRAY['Viewer'];
  END IF;
  IF jsonb_typeof(v_deny -> 'roles' -> 'download') = 'array'
     AND EXISTS (SELECT 1 FROM unnest(v_roles) AS r WHERE (v_deny -> 'roles' -> 'download') ? r) THEN
    RETURN true;
  END IF;
  -- By any team the uid is on.
  IF jsonb_typeof(v_deny -> 'teams' -> 'download') = 'array'
     AND EXISTS (SELECT 1 FROM team_members t
                  WHERE t.uid = p_uid AND (v_deny -> 'teams' -> 'download') ? t.team_id::text) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION user_download_denied(jsonb, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION user_download_denied(jsonb, uuid, uuid) TO authenticated, service_role;

-- ── 2. INSERT: the 20261080 body, byte-carried, plus the download-deny arm ──
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
  -- P1 SHARE: the minting tier — controllers (by collection) or a publisher
  -- granted on the document's library, asked of the database's own evaluator.
  AND (
    is_org_controller(document_shares.org_id)
    OR EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_shares.document_id
        AND user_can_publish_on_library(d.library_id, auth.uid()::text, document_shares.org_id)
    )
  )
  -- P1 SHARE: a Draft / Superseded / Void / Archived or held document is refused.
  AND document_share_refusal(document_shares.document_id, document_shares.org_id) IS NULL
  -- SHR-14 (P12): a creator denied download on the document — by uid, by any
  -- role in their collection, or by team — is refused. The routes refuse
  -- every pull of such a link (lib/shareServe.ts creatorMayShare), so the
  -- mint could only ever be a dead link that looks live to its creator.
  AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_shares.document_id
      AND user_download_denied(d.acl_index, auth.uid(), document_shares.org_id)
  )
);

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows carry ok NULL and the
--    count in n. pg_policies.qual / with_check are DEPARSED (no casts inside a
--    LIKE pattern); pg_proc.prosrc is verbatim.
SELECT 'SHR-14: user_download_denied(jsonb, uuid, uuid) exists, SECURITY DEFINER, search_path pinned' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'user_download_denied'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'SHR-14: user_download_denied reads the uid, every role in the collection (Viewer when none) and the teams; a signed-in caller asks about themself only',
       (SELECT prosrc LIKE '%(v_deny -> ''users'' -> ''download'') ? p_uid::text%'
           AND prosrc LIKE '%v_roles := ARRAY[''Viewer''];%'
           AND prosrc LIKE '%(v_deny -> ''roles'' -> ''download'') ? r%'
           AND prosrc LIKE '%(v_deny -> ''teams'' -> ''download'') ? t.team_id::text%'
           AND prosrc LIKE '%IF auth.uid() IS NOT NULL AND p_uid IS DISTINCT FROM auth.uid() THEN%'
          FROM pg_proc WHERE proname = 'user_download_denied'),
       NULL
UNION ALL
SELECT 'SHR-14: anon may not execute user_download_denied; authenticated may (the INSERT policy runs as the caller)',
       NOT has_function_privilege('anon', 'user_download_denied(jsonb, uuid, uuid)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'user_download_denied(jsonb, uuid, uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'SHR-14: document_shares_insert refuses a creator a download deny names (NOT user_download_denied on the row''s document)',
       (SELECT with_check LIKE '%user_download_denied(d.acl_index, auth.uid(), document_shares.org_id)%'
           AND with_check LIKE '%NOT (EXISTS%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'),
       NULL
UNION ALL
SELECT 'SHR-14: the 20261080 arms survive (creator = caller, active member, readable org-joined document, the minting tier, document_share_refusal IS NULL)',
       (SELECT with_check LIKE '%created_by = auth.uid()%'
           AND with_check LIKE '%m.status = ''active''%'
           AND with_check LIKE '%node_visible(d.visibility, d.acl_index, d.org_id, d.owner_user_id, d.collection_id, d.library_id)%'
           AND with_check LIKE '%is_org_controller(%'
           AND with_check LIKE '%user_can_publish_on_library(d.library_id%'
           AND with_check LIKE '%document_share_refusal(%'
          FROM pg_policies WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'),
       NULL
UNION ALL
SELECT 'exactly four policies on document_shares, one per verb (org_select / insert / update / delete)',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE tablename = 'document_shares')
       AND (SELECT COUNT(*) = 0 FROM pg_policies WHERE tablename = 'document_shares' AND cmd = 'ALL'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM dc_round_f_140_before;
