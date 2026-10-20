-- ─────────────────────────────────────────────────────────────────────────────
-- 20261227_dc_roundG_share_created_audit.sql
--
-- document-control Round G — P27 SHARE REMAINDERS: a share link written
-- straight into document_shares leaves the same SHARE_LINK_CREATED audit row
-- the app's door writes (intelligence DACL-4 criterion 3, the direct-insert
-- audit row; assigned to this package at the I-12 merge, 2026-10-14).
--
-- WHY: the app's door (lib/documentShares.ts createShareLink) inserts the
-- share with the signed-in member's client and then writes SHARE_LINK_CREATED
-- (details: shareId, expiresAt, note). The same INSERT sent to PostgREST by
-- anyone holding a session — outside the app — is admitted by the INSERT
-- policy on the same rules (20261080's minting tier and refusals; 20261140's
-- download-deny arm) and recorded NOTHING: a link that serves the document to
-- the internet with no distribution record of its minting.
--
-- WHAT:
--   1. record_document_share_created() — AFTER INSERT, FOR EACH ROW. For a
--      signed-in caller (auth.uid() set — every PostgREST insert a member
--      makes, the app's door included) it writes ONE audit_logs row in the
--      app door's shape: action SHARE_LINK_CREATED, resource the document
--      (resource_type 'document', resource_id the document id), the share's
--      org, user_id the caller (the INSERT policy has already required
--      created_by = auth.uid()), details { shareId, expiresAt, note } — the
--      keys createShareLink writes, pinned to it by test — plus
--      recordedBy 'database'. The row is written in the same transaction as
--      the share: if the record cannot be written, the share is not created.
--      The service role (auth.uid() NULL: a restore — DEC-75 keeps restored
--      rows as written —, the SQL console, a server route) is not recorded
--      here: no server path mints a share today, and a restored share was
--      recorded when it was first made.
--      SECURITY DEFINER (the record never depends on the caller's own
--      audit_logs insert policy, so a legitimate mint is never refused by
--      it), search_path pinned, EXECUTE revoked from PUBLIC, anon and
--      authenticated — a trigger function is never called directly (DRLS-16).
--      The identity stamp (20261201's trg_audit_logs_identity, when pasted)
--      names the caller from their membership, as for the app's own row.
--   2. Trigger trg_document_share_created_audit AFTER INSERT ON
--      document_shares FOR EACH ROW.
--   3. document_share_creation_recorded_by_database() — true while that
--      trigger is bound and enabled. The app asks it before each mint
--      (lib/documentShares.ts isShareCreationRecordedByDatabase): true — the
--      database writes the record and the app writes none of its own;
--      missing (PGRST202 / 42883: a database before this paste), false or
--      any error — the app writes SHARE_LINK_CREATED itself, exactly today's
--      path. SECURITY INVOKER (it reads only pg_trigger), search_path pinned,
--      EXECUTE for authenticated and service_role only.
--
-- WHAT DOES NOT CHANGE: who may mint (document_shares_insert — 20261080 /
-- 20261140 — is not re-created or read), the anchor guard, the SELECT /
-- UPDATE / DELETE policies, every existing share and audit row (nothing is
-- backfilled: a share made before this paste without a record keeps none —
-- the inventory counts them), SHARE_LINK_REVOKED (still the app's), and the
-- serve-time access trail (document_share_accesses). It re-creates no
-- function, policy or trigger that exists.
--
-- PREREQUISITE: 20261080 (document-control Round F wave 2, P1 SHARE — the
-- minting tier, document_share_refusal, the 90-day ceiling). DACL-4
-- criterion 3's database half is that file AND this one; this file's first
-- statement refuses to run, changing nothing, without 20261080. 20261140
-- (SHR-14, after 20261080) is independent of this file.
--
-- HOW TO APPLY — PASTE AND DEPLOY ORDER: either order. The app carrying P27
-- works on every database: before this paste the probe is missing and the
-- app writes SHARE_LINK_CREATED itself (today's path); after it the database
-- writes the one record and the app writes none. Pasted BEFORE the P27 app
-- deploys, today's app and this trigger would each write a row for an app
-- mint (two rows, never none) until the deploy lands — deploy first to keep
-- that window at zero. A paste between the app's probe and its insert is the
-- same two rows.
--
-- REVERSAL: DROP TRIGGER IF EXISTS trg_document_share_created_audit ON
-- document_shares; — the probe then answers false and the app writes its
-- own record again, as before this paste.
--
-- Single paste: prerequisite check → temp-table inventory → BEGIN / DDL /
-- COMMIT → ONE SELECT (check text, ok boolean, n text). Probes carry ok with
-- n NULL (expect ok = true on every probe row); inventory rows carry ok NULL
-- and the count in n — aggregate counts only, never a row.
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisite (refuse to run, changing nothing, without 20261080) ────────
DO $$
BEGIN
  IF to_regprocedure('public.document_share_refusal(uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'
                       AND with_check LIKE '%document_share_refusal(%') THEN
    RAISE EXCEPTION '20261227 needs 20261080 (P1 SHARE: document_share_refusal and the minting-tier INSERT policy) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS dc_round_g_227_before;
CREATE TEMP TABLE dc_round_g_227_before AS
SELECT 1 AS ord, 'inventory (before apply): share rows (all)' AS inventory,
       COUNT(*)::text AS n
  FROM document_shares
UNION ALL
SELECT 2, 'inventory (before apply): share rows with a SHARE_LINK_CREATED record naming them (details.shareId)',
       COUNT(*)::text
  FROM document_shares s
 WHERE EXISTS (SELECT 1 FROM audit_logs a
                WHERE a.action = 'SHARE_LINK_CREATED' AND a.details->>'shareId' = s.id::text)
UNION ALL
SELECT 3, 'inventory (before apply): share rows with NO SHARE_LINK_CREATED record (minted outside the app door, before the door recorded, or restored; kept as they are — never backfilled)',
       COUNT(*)::text
  FROM document_shares s
 WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'SHARE_LINK_CREATED' AND a.details->>'shareId' = s.id::text)
UNION ALL
SELECT 4, 'inventory (before apply): of those, LIVE (unrevoked, unexpired) — links serving today with no record of their minting',
       COUNT(*)::text
  FROM document_shares s
 WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'SHARE_LINK_CREATED' AND a.details->>'shareId' = s.id::text)
UNION ALL
SELECT 5, 'inventory (before apply): SHARE_LINK_CREATED rows (all; kept as written)',
       COUNT(*)::text
  FROM audit_logs a
 WHERE a.action = 'SHARE_LINK_CREATED';

BEGIN;

-- ── 1. The database's record of a share's minting ──────────────────────────
-- One row per share a signed-in caller inserts, in the same transaction as
-- the insert; the app door's shape (lib/documentShares.ts createShareLink —
-- pinned to this body by test).
CREATE OR REPLACE FUNCTION record_document_share_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();   -- NULL for the service role / SQL console
BEGIN
  -- The service role (a restore, the SQL console, a server route) is the
  -- server's word: not recorded here.
  IF v_actor IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
  VALUES ('SHARE_LINK_CREATED', NEW.document_id::text, 'document', NEW.org_id, v_actor,
          jsonb_build_object(
            'shareId', NEW.id,
            'expiresAt', NEW.expires_at,
            'note', NEW.note,
            'recordedBy', 'database'
          ));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION record_document_share_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_document_share_created_audit ON document_shares;
CREATE TRIGGER trg_document_share_created_audit
AFTER INSERT ON document_shares
FOR EACH ROW EXECUTE FUNCTION record_document_share_created();

-- ── 2. What the app asks before each mint ──────────────────────────────────
-- True while the trigger above is bound and enabled — then the database
-- writes the record and the app writes none. Missing (before this paste) or
-- false: the app writes it, as today.
CREATE OR REPLACE FUNCTION document_share_creation_recorded_by_database()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.document_shares'::regclass
       AND t.tgname = 'trg_document_share_created_audit'
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  );
$$;
REVOKE ALL ON FUNCTION document_share_creation_recorded_by_database() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION document_share_creation_recorded_by_database() TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. pg_policies.with_check is DEPARSED;
--    pg_proc.prosrc is verbatim.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'prerequisite: 20261080 is in place (document_share_refusal; the INSERT policy carries it)' AS check,
       (to_regprocedure('public.document_share_refusal(uuid,uuid)') IS NOT NULL
        AND EXISTS (SELECT 1 FROM pg_policies
                     WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'
                       AND with_check LIKE '%document_share_refusal(%')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'DACL-4 c3: the record is SHARE_LINK_CREATED in the app door''s shape (resource the document; details shareId, expiresAt, note; recordedBy database), for a signed-in caller only',
       (SELECT prosrc LIKE '%IF v_actor IS NULL THEN%RETURN NULL;%INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)%VALUES (''SHARE_LINK_CREATED'', NEW.document_id::text, ''document'', NEW.org_id, v_actor,%''shareId'', NEW.id,%''expiresAt'', NEW.expires_at,%''note'', NEW.note,%''recordedBy'', ''database''%'
          FROM pg_proc WHERE proname = 'record_document_share_created'),
       NULL
UNION ALL
SELECT 1, 3, 'DACL-4 c3: trg_document_share_created_audit fires AFTER INSERT FOR EACH ROW on document_shares (tgtype: ROW + INSERT, not BEFORE, not UPDATE), enabled',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'public.document_shares'::regclass
                  AND tgname = 'trg_document_share_created_audit' AND NOT tgisinternal
                  AND tgenabled <> 'D'
                  AND (tgtype & 1) <> 0 AND (tgtype & 2) = 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) = 0),
       NULL
UNION ALL
SELECT 1, 4, 'DRLS-16: record_document_share_created is SECURITY DEFINER with search_path pinned; PUBLIC, anon and authenticated may not execute it',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'record_document_share_created' AND p.prosecdef
                AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'record_document_share_created()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'record_document_share_created()', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname = 'record_document_share_created' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 5, 'DACL-4 c3: document_share_creation_recorded_by_database() answers true (the app now writes no SHARE_LINK_CREATED of its own); authenticated may execute it, anon may not; search_path pinned',
       COALESCE(document_share_creation_recorded_by_database(), false)
       AND has_function_privilege('authenticated', 'document_share_creation_recorded_by_database()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'document_share_creation_recorded_by_database()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'document_share_creation_recorded_by_database'
                    AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 1, 6, 'nothing else changed: document_shares still carries its four policies, one per verb, and the INSERT policy still names the minting tier',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE tablename = 'document_shares')
       AND (SELECT COUNT(*) = 0 FROM pg_policies WHERE tablename = 'document_shares' AND cmd = 'ALL')
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert'
                      AND with_check LIKE '%is_org_controller(%' AND with_check LIKE '%user_can_publish_on_library(d.library_id%'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM dc_round_g_227_before
) AS result
ORDER BY sec, ord;
