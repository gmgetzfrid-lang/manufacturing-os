-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — OWN-22: a library's ownership, access
-- control and compliance policy are controller-set at BIRTH too.
--
-- 20261036 (OWN-1) put the sensitive columns of `libraries` — ownership
-- (owner_user_id / owner_name / owner_team_id), access (acl / acl_index /
-- default_new_acl) and compliance policy (review_control / review_policy /
-- retention_policy / ack_policy / recert_policy) — behind a BEFORE UPDATE
-- guard: a controller, the CURRENT owner, or an ACL manage-grant. It left
-- INSERT to the table's one policy (libraries_org_access FOR ALL USING
-- (org membership), no WITH CHECK), so any active member could still POST a
-- library row naming THEMSELVES its owner, or carrying an acl_index that
-- grants themselves admin — and library ownership is authority: the owner
-- passes the UPDATE guard on every sensitive column (rewrite the ACL, grant
-- publish to the whole org), enforce_document_publish_guard on every
-- document in the library (publish / supersede / archive), the retention
-- authority (dispose) and revision_branches_org_update. The Save-As door
-- (lib/libraryCollections.ts#createLibrary, offered to Manager / Supervisor)
-- now stamps a CONTROLLER creator only; this rail makes the INSERT path
-- mirror the UPDATE guard so no client can reopen the door.
--
-- Rule: an authenticated non-controller may still CREATE a library (the door
-- stays open to the tiers the app offers it to), but the row must be born
-- with the sensitive columns NULL — unowned, no ACL, no policy. A controller
-- (is_org_controller — the role COLLECTION, DEC-2) may set them on the insert
-- or afterwards; the service role (auth.uid() IS NULL) passes. The legacy
-- read_access / write_access / admin_access / visible_to / folder_security /
-- default_new_visibility columns carry defaults, are evaluated by nothing
-- (acl_index is what the database enforces) and stay out of the rail.
--
-- NARROWING: nobody gains. Single paste: BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent;
-- safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── OWN-22: library INSERT rail (mirror of the 20261036 UPDATE guard) ───────
CREATE OR REPLACE FUNCTION enforce_library_insert_sensitive_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (NEW.owner_user_id IS NOT NULL
      OR NEW.owner_name IS NOT NULL
      OR NEW.owner_team_id IS NOT NULL
      OR NEW.acl IS NOT NULL
      OR NEW.acl_index IS NOT NULL
      OR NEW.default_new_acl IS NOT NULL
      OR NEW.review_control IS NOT NULL
      OR NEW.review_policy IS NOT NULL
      OR NEW.retention_policy IS NOT NULL
      OR NEW.ack_policy IS NOT NULL
      OR NEW.recert_policy IS NOT NULL) THEN
    IF NOT is_org_controller(NEW.org_id) THEN
      RAISE EXCEPTION 'Not permitted to create a library with an owner, access control, or compliance policy set. Ask an Admin or Document Control.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_library_insert_sensitive_columns ON libraries;
CREATE TRIGGER trg_library_insert_sensitive_columns
BEFORE INSERT ON libraries
FOR EACH ROW EXECUTE FUNCTION enforce_library_insert_sensitive_columns();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 6. Inventory rows: n = the aggregate count.
SELECT 'library INSERT rail installed (BEFORE INSERT, FOR EACH ROW)' AS check,
       (SELECT EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgname = 'trg_library_insert_sensitive_columns' AND NOT t.tgisinternal
                          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT ON public.libraries FOR EACH ROW%')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the rail refuses a non-controller row born with an owner, ACL or policy (service role passes)',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW%'
              AND prosrc LIKE '%NEW.owner_user_id IS NOT NULL%'
              AND prosrc LIKE '%NEW.acl_index IS NOT NULL%'
              AND prosrc LIKE '%NEW.review_control IS NOT NULL%'
              AND prosrc LIKE '%IF NOT is_org_controller(NEW.org_id) THEN%'
          FROM pg_proc WHERE proname = 'enforce_library_insert_sensitive_columns'),
       NULL::text
UNION ALL
-- plpgsql binds NEW.<column> at run time — a missing column would break every
-- library insert, so every column the rail names must exist.
SELECT 'every column the rail names exists on libraries',
       (SELECT COUNT(*) = 11 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'libraries'
           AND column_name IN ('owner_user_id','owner_name','owner_team_id','acl','acl_index','default_new_acl',
                               'review_control','review_policy','retention_policy','ack_policy','recert_policy')),
       NULL::text
UNION ALL
SELECT 'the 20261036 UPDATE guard is still installed (both rails together)',
       (SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_library_sensitive_columns' AND NOT tgisinternal)),
       NULL::text
UNION ALL
SELECT 'enforce_library_insert_sensitive_columns is SECURITY DEFINER with search_path pinned',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_library_insert_sensitive_columns'),
       NULL::text
UNION ALL
SELECT 'is_org_controller (the additive controller primitive) is present for the rail to call',
       (SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_org_controller')),
       NULL::text
UNION ALL
-- Libraries that were born self-owned by a NON-controller creator (the
-- population the Save-As stamp could have produced before this rail). Their
-- owner keeps the owner arm of the UPDATE guard until a controller reassigns
-- them — expect 0; anything else is a list for Document Control to review.
SELECT 'inventory: libraries self-owned by a non-controller creator', NULL::boolean, COUNT(*)::text
  FROM libraries l
 WHERE l.owner_user_id IS NOT NULL
   AND l.owner_user_id::text = l.created_by::text
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = l.org_id AND m.uid = l.owner_user_id AND m.status = 'active'
                      AND (m.role IN ('Admin','DocCtrl') OR m.roles && ARRAY['Admin','DocCtrl']::text[]))
UNION ALL
SELECT 'inventory: libraries with no owner (user or team) — the register / console population', NULL::boolean, COUNT(*)::text
  FROM libraries WHERE owner_user_id IS NULL AND owner_team_id IS NULL;
