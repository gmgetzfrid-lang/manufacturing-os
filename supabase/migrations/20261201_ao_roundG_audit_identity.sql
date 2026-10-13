-- 20261201_ao_roundG_audit_identity.sql
--
-- admin-and-org Round G — package P7 (audit-log integrity): ALOG-7, and the
-- actor_kind half of drafting-flow EVID-6 / PERS-7 (re-owned to P7 at the
-- DF-P1 merge). Decision (the integrator's, under the user's delegation,
-- DEC-90 practice: fail safe): the audit row's identity is RESOLVED BY THE
-- DATABASE for a signed-in caller; the service role's rows keep what the
-- server wrote; a new column, actor_kind, says which. Existing rows are
-- untouched and counted.
--
-- WHY:
--   audit_logs stores user_email, user_role and "timestamp" exactly as the
--   inserter sent them. The only rule on a signed-in insert is
--   audit_logs_insert (20260813_acl_close_gaps_and_audit_scope.sql:85-90):
--   user_id = auth.uid() and an org the caller belongs to. Nothing ties the
--   email or the role to the caller's membership, and nothing pins the time
--   (only MILESTONE_* rows are clocked, by 20261157 §9). So any active member
--   can POST /rest/v1/audit_logs with their own uid, user_role 'Admin', a
--   timestamp six months back and any action, and both viewers show it as
--   real. The viewers then render user_email before user_id.
--
-- WHAT:
--   1. audit_logs.actor_kind text (nullable; CHECK member / server / system).
--      NULL on every existing row — a row written before this paste says
--      nothing about whose word its identity is, and the viewer labels it so.
--   2. audit_logs_stamp_identity() — BEFORE INSERT, every row:
--        * no session uid (the service role: the server routes, the cron,
--          the restore, the SQL editor): what the server wrote stands —
--          user_id, email, role and time untouched (a restore keeps its rows
--          as written; DEC-87 §3: a machine row's user_id stays NULL, so the
--          export ledgers, which read only user_id NULL rows, still hold).
--          actor_kind = 'system' when user_id is NULL, else 'server'.
--        * a session, and a row naming no person (user_id NULL): only a
--          SECURITY DEFINER function can write one (audit_logs_insert refuses
--          a member's NULL uid) — a database function's machine row, kept as
--          written; actor_kind = 'system'.
--        * a session, and a row naming someone else: again only a definer
--          function can write it — kept as written; actor_kind = 'server'.
--        * a session, and the caller's own row (user_id = auth.uid()): the
--          database names them. user_email := the membership's email
--          (org_members, the row's org), else the sign-in email (auth.users);
--          user_role := the role the caller sent when the membership holds it
--          (the headline or any role in the collection — e.g. the role a
--          surface admitted them by), else the membership's headline;
--          "timestamp" := now(). A value the caller sent that differs is not
--          lost: it is kept under metadata.asserted (user_email / user_role /
--          timestamp), so a stored-vs-sent discrepancy is detectable.
--          actor_kind = 'member'.
--          A caller's own row in an org they are not a member of can only
--          come from a definer function — kept as written, 'server'. A row
--          with no org (admitted until 20261202 is pasted) is named from the
--          sign-in email, with no role ('member').
--      SECURITY DEFINER (it reads org_members and auth.users whatever the
--      writer may read), search_path pinned, EXECUTE revoked from PUBLIC,
--      anon and authenticated (a trigger function is never called directly).
--   3. Trigger trg_audit_logs_identity BEFORE INSERT FOR EACH ROW.
--
-- WHAT DOES NOT CHANGE: who may insert (audit_logs_insert, untouched here),
-- who may read (the SELECT policies, untouched), every existing row (no
-- UPDATE is run), and every service-role row (the server's word stands).
-- No writer changes: lib/audit.ts keeps its signature and every call site is
-- unchanged. A legitimate member's row is written as before, now with their
-- real email and role.
--
-- APP BEFORE AND AFTER THE PASTE: the app reads actor_kind with select("*"),
-- so before the paste the column is simply absent (every row is labelled
-- "as sent by the writer" in /admin/audit) and nothing writes it — no
-- 42703 / PGRST204 path. After it, new rows carry it.
--
-- PASTE AND DEPLOY ORDER: either order; independent of every other pending
-- file (it re-creates no function, policy or trigger that exists). It runs
-- beside 20261157's two BEFORE INSERT triggers when that file is pasted:
-- trg_audit_logs_identity fires first (triggers fire in name order) and
-- neither touches what the other sets. Pasting 20261202 is a separate step.
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_audit_logs_identity ON audit_logs;
--   DROP FUNCTION IF EXISTS public.audit_logs_stamp_identity();
--   ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_kind_check;
--   ALTER TABLE audit_logs DROP COLUMN IF EXISTS actor_kind;
--   (The app keeps working: it reads the column only when present.)
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL; expect ok = true × 12)
-- and the inventory counts (ok NULL, n the count — aggregate counts only,
-- never a row). The self-test probes insert one row as an active member
-- inside a sub-transaction and roll it back: nothing is kept (they read NULL
-- on a database with no active member).

-- ── Before-apply inventory (aggregate counts only, read BEFORE the change) ──
DROP TABLE IF EXISTS pg_temp._ao_g201_before;
CREATE TEMP TABLE _ao_g201_before AS
SELECT 'inventory: audit_logs rows before this paste (kept as written; none is updated)' AS inventory,
       COUNT(*)::text AS n FROM audit_logs
UNION ALL
SELECT 'inventory: rows naming no person (user_id NULL) — machine rows',
       COUNT(*)::text FROM audit_logs WHERE user_id IS NULL
UNION ALL
SELECT 'inventory: rows naming a person whose stored email is not that person''s membership email in the row''s org (caller-sent; kept as written)',
       COUNT(*)::text FROM audit_logs a
        WHERE a.user_id IS NOT NULL AND a.user_email IS NOT NULL
          AND EXISTS (SELECT 1 FROM org_members m
                       WHERE m.org_id = a.org_id AND m.uid = a.user_id AND m.email IS NOT NULL
                         AND lower(m.email) <> lower(a.user_email))
UNION ALL
SELECT 'inventory: rows naming a person whose stored role that person does not hold today (a snapshot or caller-sent; kept as written)',
       COUNT(*)::text FROM audit_logs a
        WHERE a.user_id IS NOT NULL AND a.user_role IS NOT NULL
          AND EXISTS (SELECT 1 FROM org_members m
                       WHERE m.org_id = a.org_id AND m.uid = a.user_id
                         AND m.role IS DISTINCT FROM a.user_role
                         AND NOT (a.user_role = ANY (COALESCE(m.roles, '{}'::text[]))))
UNION ALL
SELECT 'inventory: rows dated in the future (timestamp more than 5 minutes ahead of now; kept as written)',
       COUNT(*)::text FROM audit_logs WHERE "timestamp" > now() + interval '5 minutes'
UNION ALL
SELECT 'inventory: actor_kind column present before this paste (0 = first apply; 1 = a re-run)',
       COUNT(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'actor_kind';

BEGIN;

-- ── 1. actor_kind: whose word the row's identity is ─────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_kind text;
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_kind_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_kind_check
  CHECK (actor_kind IS NULL OR actor_kind IN ('member', 'server', 'system'));

COMMENT ON COLUMN audit_logs.actor_kind IS
  'ALOG-7 (20261201): whose word the row''s identity is. member = a signed-in caller''s own row, user_email / user_role / timestamp stamped by the database (what the caller sent, if different, is in metadata.asserted); server = written by the service role or a database function (the writer''s word stands); system = no person (user_id NULL). NULL = written before 20261201 (the writer''s word, unlabelled).';

-- ── 2. the stamp ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_logs_stamp_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_role text;
  v_roles text[];
  v_found boolean := false;
  v_stamped_role text;
  v_asserted jsonb := '{}'::jsonb;
BEGIN
  -- The service pass: the server's word stands (a restore keeps its rows).
  IF v_uid IS NULL THEN
    NEW.actor_kind := CASE WHEN NEW.user_id IS NULL THEN 'system' ELSE 'server' END;
    RETURN NEW;
  END IF;
  -- A database function's machine row (a member cannot insert a NULL uid).
  IF NEW.user_id IS NULL THEN
    NEW.actor_kind := 'system';
    RETURN NEW;
  END IF;
  -- A database function naming another person (a member cannot).
  IF NEW.user_id <> v_uid THEN
    NEW.actor_kind := 'server';
    RETURN NEW;
  END IF;
  -- The caller's own row: the database names them.
  IF NEW.org_id IS NOT NULL THEN
    SELECT m.email, m.role, m.roles INTO v_email, v_role, v_roles
      FROM org_members m
     WHERE m.org_id = NEW.org_id AND m.uid = v_uid
     LIMIT 1;
    v_found := FOUND;
    IF NOT v_found THEN
      -- Not a member of the row's org: only a definer function writes this.
      NEW.actor_kind := 'server';
      RETURN NEW;
    END IF;
  END IF;
  IF v_email IS NULL THEN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;
  END IF;
  v_stamped_role := CASE
    WHEN NOT v_found THEN NULL
    WHEN NEW.user_role IS NOT NULL
         AND (NEW.user_role = v_role OR NEW.user_role = ANY (COALESCE(v_roles, '{}'::text[]))) THEN NEW.user_role
    ELSE v_role
  END;
  IF NEW.user_email IS NOT NULL AND lower(NEW.user_email) IS DISTINCT FROM lower(v_email) THEN
    v_asserted := v_asserted || jsonb_build_object('user_email', NEW.user_email);
  END IF;
  IF NEW.user_role IS NOT NULL AND NEW.user_role IS DISTINCT FROM v_stamped_role THEN
    v_asserted := v_asserted || jsonb_build_object('user_role', NEW.user_role);
  END IF;
  IF NEW."timestamp" IS NOT NULL AND NEW."timestamp" IS DISTINCT FROM now() THEN
    v_asserted := v_asserted || jsonb_build_object('timestamp', NEW."timestamp");
  END IF;
  IF v_asserted <> '{}'::jsonb THEN
    NEW.metadata := CASE
      WHEN NEW.metadata IS NULL THEN jsonb_build_object('asserted', v_asserted)
      WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata || jsonb_build_object('asserted', v_asserted)
      ELSE jsonb_build_object('value', NEW.metadata, 'asserted', v_asserted)
    END;
  END IF;
  NEW.user_email := v_email;
  NEW.user_role := v_stamped_role;
  NEW."timestamp" := now();
  NEW.actor_kind := 'member';
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.audit_logs_stamp_identity() IS
  'ALOG-7 (20261201): BEFORE INSERT on audit_logs. A signed-in caller''s own row gets user_email from the membership (else the sign-in email), user_role = the role sent when the membership holds it (else the headline), "timestamp" = now(), actor_kind member; a differing sent value is kept in metadata.asserted. The service role''s rows, a database function''s machine rows and its rows naming another person keep what was written (actor_kind server / system). Nobody may call it.';

REVOKE ALL ON FUNCTION public.audit_logs_stamp_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_logs_stamp_identity() FROM anon;
REVOKE ALL ON FUNCTION public.audit_logs_stamp_identity() FROM authenticated;

-- ── 3. the trigger ──────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_logs_identity ON audit_logs;
CREATE TRIGGER trg_audit_logs_identity
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_logs_stamp_identity();

COMMIT;

-- ── Self-test (rolled back; booleans only, never a row) ─────────────────────
-- One active member's own row with a forged email, role and time, and one
-- service-pass row, each inserted inside a sub-transaction that is undone.
DROP TABLE IF EXISTS pg_temp._ao_g201_selftest;
CREATE TEMP TABLE _ao_g201_selftest (probe text, ok boolean);
DO $selftest$
DECLARE
  v_org uuid;
  v_uid uuid;
  v_row audit_logs%ROWTYPE;
  v_srv audit_logs%ROWTYPE;
  v_member_ok boolean;
  v_service_ok boolean;
BEGIN
  SELECT m.org_id, m.uid INTO v_org, v_uid
    FROM org_members m WHERE m.status = 'active' AND m.email IS NOT NULL LIMIT 1;
  IF v_uid IS NOT NULL THEN
    BEGIN
      -- set_config(..., true) and both rows are undone with the sub-transaction.
      PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, "timestamp")
      VALUES ('ALOG7_SELF_TEST', 'self-test', 'org', v_org, v_uid, 'forged@example.invalid', 'NotARole', now() - interval '180 days')
      RETURNING * INTO v_row;
      PERFORM set_config('request.jwt.claims', '', true);
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role)
      VALUES ('ALOG7_SELF_TEST', 'self-test', 'org', v_org, NULL, 'system:self-test', 'system')
      RETURNING * INTO v_srv;
      v_member_ok := v_row.actor_kind = 'member'
                     AND v_row.user_email IS DISTINCT FROM 'forged@example.invalid'
                     AND v_row.user_role IS DISTINCT FROM 'NotARole'
                     AND v_row."timestamp" > now() - interval '1 minute'
                     AND v_row.metadata -> 'asserted' ->> 'user_email' = 'forged@example.invalid'
                     AND v_row.metadata -> 'asserted' ->> 'user_role' = 'NotARole'
                     AND v_row.metadata -> 'asserted' ? 'timestamp';
      v_service_ok := v_srv.actor_kind = 'system' AND v_srv.user_id IS NULL
                      AND v_srv.user_email = 'system:self-test' AND v_srv.user_role = 'system';
      RAISE EXCEPTION 'ao_g201_selftest_rollback';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'ao_g201_selftest_rollback' THEN RAISE; END IF;
    END;
  END IF;
  INSERT INTO _ao_g201_selftest VALUES ('member', v_member_ok), ('service', v_service_ok);
END
$selftest$;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 12 (n NULL; the two self-tests read NULL on a database
-- with no active member). Inventory rows: ok NULL, n = the count.
SELECT 'audit_logs.actor_kind exists (text, nullable)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'actor_kind'
                  AND data_type = 'text' AND is_nullable = 'YES') AS ok,
       NULL::text AS n
UNION ALL SELECT 'actor_kind admits only member / server / system (or NULL)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.audit_logs'::regclass AND conname = 'audit_logs_actor_kind_check'
                  AND pg_get_constraintdef(oid) LIKE '%member%' AND pg_get_constraintdef(oid) LIKE '%server%'
                  AND pg_get_constraintdef(oid) LIKE '%system%'), NULL
UNION ALL SELECT 'every row written before this paste is untouched (actor_kind NULL on each of them)',
       (SELECT COUNT(*) FROM audit_logs WHERE actor_kind IS NULL)
         = (SELECT n::bigint FROM _ao_g201_before WHERE inventory LIKE 'inventory: audit_logs rows before%')
       OR EXISTS (SELECT 1 FROM _ao_g201_before WHERE inventory LIKE 'inventory: actor_kind column present%' AND n = '1'), NULL
UNION ALL SELECT 'audit_logs_stamp_identity is SECURITY DEFINER with search_path pinned to public',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'audit_logs_stamp_identity'
                  AND p.prosecdef AND 'search_path=public' = ANY (COALESCE(p.proconfig, '{}'::text[]))), NULL
UNION ALL SELECT 'nobody may call it: no EXECUTE for PUBLIC, anon or authenticated',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = 'audit_logs_stamp_identity'
                      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))), NULL
UNION ALL SELECT 'the service pass keeps what the server wrote (no session uid → return before any stamp)',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'audit_logs_stamp_identity'
                  AND p.prosrc LIKE '%IF v_uid IS NULL THEN%NEW.actor_kind := CASE WHEN NEW.user_id IS NULL THEN ''system'' ELSE ''server'' END;%RETURN NEW;%'), NULL
UNION ALL SELECT 'a signed-in caller''s own row: email and role from org_members, time from the server, kind member',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'audit_logs_stamp_identity'
                  AND p.prosrc LIKE '%FROM org_members m%WHERE m.org_id = NEW.org_id AND m.uid = v_uid%'
                  AND p.prosrc LIKE '%NEW.user_email := v_email;%NEW.user_role := v_stamped_role;%NEW."timestamp" := now();%NEW.actor_kind := ''member'';%'), NULL
UNION ALL SELECT 'a differing sent value is kept under metadata.asserted, never dropped',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'audit_logs_stamp_identity'
                  AND p.prosrc LIKE '%jsonb_build_object(''asserted'', v_asserted)%'), NULL
UNION ALL SELECT 'trg_audit_logs_identity fires BEFORE INSERT FOR EACH ROW on audit_logs and is enabled',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.audit_logs'::regclass AND t.tgname = 'trg_audit_logs_identity'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION %audit_logs_stamp_identity()%'), NULL
UNION ALL SELECT 'audit_logs is still append-only for signed-in callers (no UPDATE / DELETE / ALL policy)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd IN ('UPDATE', 'DELETE', 'ALL')), NULL
UNION ALL SELECT 'self-test: a member''s forged email, role and back-dated time are replaced and kept under metadata.asserted (rolled back)',
       (SELECT ok FROM _ao_g201_selftest WHERE probe = 'member'), NULL
UNION ALL SELECT 'self-test: a service-pass machine row keeps user_id NULL, its label and its role — kind system (rolled back)',
       (SELECT ok FROM _ao_g201_selftest WHERE probe = 'service'), NULL
UNION ALL SELECT inventory, NULL, n FROM _ao_g201_before
UNION ALL SELECT 'after: rows carrying actor_kind (0 right after the paste; the self-test rows were rolled back)',
       NULL, (SELECT COUNT(*)::text FROM audit_logs WHERE actor_kind IS NOT NULL);
