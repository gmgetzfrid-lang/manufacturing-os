-- ─────────────────────────────────────────────────────────────────────────────
-- 20261150_dc_roundF_work_package_repin_record.sql
--
-- document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS:
-- DRLS-10 done-when 3, the database half.
--
--   DRLS-10  A work package is a tripwire: it pins each member drawing's
--            revision at assembly and reads STALE when one advances. P8 made
--            the app's re-pin (lib/workPackages.ts refreshWorkPackage) write
--            WORK_PACKAGE_REPINNED — what had drifted, from → to — BEFORE any
--            pin moves. But a pin moved OUTSIDE the app (a direct PostgREST
--            PATCH of work_package_documents.pinned_version_id by the package
--            owner or a controller — both allowed by 20261032's policies)
--            left no record: the package read FRESH again with nothing saying
--            it had ever been stale.
--
--   WHAT (one new trigger; no function, policy or trigger of another
--   migration is re-created — 20261033's pin guard is untouched):
--     trg_wpd_repin_record — AFTER UPDATE OF pinned_version_id ON
--     work_package_documents, FOR EACH ROW, WHEN the pin actually moves →
--     record_work_package_repin(): one audit_logs row per moved pin, in the
--     same transaction as the move, whoever moves it (the app, a direct
--     PATCH, the service role):
--       action 'WORK_PACKAGE_PIN_MOVED', resource_type 'work_package',
--       resource_id the package, org_id the row's org, user_id auth.uid()
--       (NULL for the service role), user_email from org_members;
--       details: documentId, fromVersionId / fromRev, toVersionId / toRev,
--       the document's currentVersionId at the move, wasStale (the old pin
--       was not the current revision — the signal the move resolves),
--       toCurrent (the new pin is the current revision), source 'database'.
--     If the record cannot be written the move fails with it: no pin moves
--     unrecorded. A write that leaves the pin where it was (the app's
--     refresh rewrites every member, fresh ones included) records nothing.
--     The app's WORK_PACKAGE_REPINNED summary (and its _REFUSED correction)
--     is unchanged; this row is the per-pin, database-side fact beside it.
--   SECURITY DEFINER (the audit row is written whatever the mover's view of
--   audit_logs), SET search_path = public, EXECUTE revoked from PUBLIC,
--   anon, authenticated and service_role (a trigger function: DRLS-16).
--
-- NOT a widening: it refuses nothing a person could do and grants nothing;
-- it records. DEC-30 inventory (aggregate counts only, before the
-- transaction): open / executing packages, their pins, and the pins that are
-- stale right now (each one's next re-pin is recorded from this paste on).
-- HOW TO APPLY: after 20261033 (the pin guard it sits beside) and 20261032
-- (the pin policies). Independent of 20261131, 20261139, 20261143 (the
-- work_packages close rail — another table) and 20261144; any order among
-- them. Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_150_before;
CREATE TEMP TABLE dc_round_f_150_before AS
SELECT 'inventory (before apply): work packages not closed (open or executing)' AS inventory,
       COUNT(*)::text AS n
  FROM work_packages WHERE COALESCE(status, '') <> 'closed'
UNION ALL
SELECT 'inventory (before apply): pins in packages not closed',
       COUNT(*)::text
  FROM work_package_documents wpd
  JOIN work_packages p ON p.id = wpd.package_id
 WHERE COALESCE(p.status, '') <> 'closed'
UNION ALL
SELECT 'inventory (before apply): pins in packages not closed that are STALE right now (the pin is not the document''s current revision) — each one''s next re-pin is recorded from this paste on',
       COUNT(*)::text
  FROM work_package_documents wpd
  JOIN work_packages p ON p.id = wpd.package_id
  JOIN documents d ON d.id = wpd.document_id
 WHERE COALESCE(p.status, '') <> 'closed'
   AND wpd.pinned_version_id IS DISTINCT FROM d.current_version_id;

BEGIN;

-- ── DRLS-10: every moved pin is on the record, whoever moves it ─────────────
CREATE OR REPLACE FUNCTION record_work_package_repin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor   uuid := auth.uid();   -- NULL for the service role / SQL console
  v_current uuid;
  v_email   text;
BEGIN
  SELECT d.current_version_id INTO v_current
    FROM documents d WHERE d.id = NEW.document_id;
  IF v_actor IS NOT NULL THEN
    SELECT m.email INTO v_email
      FROM org_members m
     WHERE m.org_id = NEW.org_id AND m.uid = v_actor
     LIMIT 1;
  END IF;
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('WORK_PACKAGE_PIN_MOVED', NEW.package_id::text, 'work_package', NEW.org_id, v_actor, v_email,
          jsonb_build_object(
            'documentId', NEW.document_id,
            'fromVersionId', OLD.pinned_version_id,
            'fromRev', OLD.pinned_rev_label,
            'toVersionId', NEW.pinned_version_id,
            'toRev', NEW.pinned_rev_label,
            'currentVersionId', v_current,
            'wasStale', OLD.pinned_version_id IS DISTINCT FROM v_current,
            'toCurrent', NEW.pinned_version_id IS NOT DISTINCT FROM v_current,
            'source', 'database'
          ));
  RETURN NULL;
END;
$$;
-- A trigger function is never called by a client (it RETURNS trigger); its
-- EXECUTE is checked when a trigger is created, not when it fires, so no
-- client role needs it (DRLS-16: grant only to the roles that call it).
REVOKE ALL ON FUNCTION record_work_package_repin() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_wpd_repin_record ON work_package_documents;
CREATE TRIGGER trg_wpd_repin_record
  AFTER UPDATE OF pinned_version_id ON work_package_documents
  FOR EACH ROW
  WHEN (OLD.pinned_version_id IS DISTINCT FROM NEW.pinned_version_id)
  EXECUTE FUNCTION record_work_package_repin();

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 4. Inventory rows: n = the aggregate count.
SELECT 'DRLS-10: a moved pin writes its record in the same transaction (trg_wpd_repin_record, AFTER UPDATE OF pinned_version_id, only when the pin moves)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_wpd_repin_record'
                  AND tgrelid = 'work_package_documents'::regclass AND NOT tgisinternal
                  AND pg_get_triggerdef(oid) LIKE '%AFTER UPDATE OF pinned_version_id ON public.work_package_documents FOR EACH ROW WHEN ((old.pinned_version_id IS DISTINCT FROM new.pinned_version_id)) EXECUTE FUNCTION record_work_package_repin()%') AS ok,
       NULL::text AS n
UNION ALL SELECT 'DRLS-10: the record names the package, the document, from and to, and whether the old pin was stale',
       (SELECT prosrc LIKE '%''WORK_PACKAGE_PIN_MOVED'', NEW.package_id%'
               AND prosrc LIKE '%''work_package'', NEW.org_id, v_actor, v_email%'
               AND prosrc LIKE '%''fromVersionId'', OLD.pinned_version_id%'
               AND prosrc LIKE '%''toVersionId'', NEW.pinned_version_id%'
               AND prosrc LIKE '%''wasStale'', OLD.pinned_version_id IS DISTINCT FROM v_current%'
          FROM pg_proc WHERE proname = 'record_work_package_repin'), NULL
UNION ALL SELECT 'DRLS-10: the recorder is SECURITY DEFINER with search_path pinned, and no client role may execute it',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'record_work_package_repin')
       AND NOT has_function_privilege('public', 'record_work_package_repin()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'record_work_package_repin()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'record_work_package_repin()', 'EXECUTE'), NULL
UNION ALL SELECT 'DRLS-10: the pin guard (20261033) still fires BEFORE INSERT OR UPDATE beside it',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_wpd_pin_guard'
                  AND tgrelid = 'work_package_documents'::regclass AND NOT tgisinternal), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_150_before;
