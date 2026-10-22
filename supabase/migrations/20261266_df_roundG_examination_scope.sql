-- ─────────────────────────────────────────────────────────────────────────────
-- 20261266_df_roundG_examination_scope.sql
--
-- drafting-flow Round G — DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE
-- (GAP-102 acceptances 4 and 1; the integrator's rulings (1)–(3) and (6) for
-- DF-P24 under DEC-90: industry best practice, fail-safe, no regression).
-- One addition, nothing renamed, no existing function, policy or trigger
-- re-created:
--
--   ticket_examination_scopes (new) — the examination data a request carries:
--   one row per request, `field_values` = { <field key>: { value, by, byName,
--   at } } with each value picked from the workspace's own list (the fields
--   and their values are configuration — org_configurations 'drafting', key
--   examinationScope, Admin → Request forms; DEC-35: no facility word in
--   code), and `waiver` = why the request issues without data its
--   requirement names (a required reason, who, when, the fields it covers and
--   the revision it was recorded for) or NULL. Written ONLY by the service
--   role (/api/tickets/examination-scope, after its checks: the drafter or
--   the engineer already in the flow, or the assignment queue, records
--   values; a person who holds the issue authority records a waiver; each
--   write's audit row first). Read as the request reads (a member who can
--   read the ticket reads its row). No client holds a write grant or policy.
--   A guard trigger (SECURITY INVOKER, search_path pinned) keeps each row in
--   its request's workspace and its request fixed. Removed with its request
--   (ON DELETE CASCADE) or workspace.
--
-- The workflow route's issue gate reads this row only for a request a
-- configured requirement applies to; a workspace that configures nothing
-- never reads it (today's path, byte for byte).
--
--   drafting_examination_scope_stamp (new, DF-P24 second fix pass) — a
--   requirement's `since` (when it starts to bind: a request filed at or
--   after it is refused an issue without the data) is the DATABASE's time,
--   never a value a client sends. A BEFORE INSERT OR UPDATE trigger on
--   org_configurations, for the 'drafting' row only (SECURITY INVOKER,
--   search_path pinned, executable by no client role), rewrites every
--   requirement's `since` on every write: an unchanged requirement (the
--   same field, work class and library as one stored in the row being
--   replaced, whose field had values to pick from there) keeps its stored
--   time; every other one — new, re-targeted, re-added, or naming a field
--   that had nothing to pick from (or did not exist) in the stored row — is
--   stamped with the database's clock plus one minute, rounded to the
--   second (the margin covers the app server's clock, which stamps
--   tickets.created_at). Whatever `since` the writer sent is ignored: the
--   admin page, a REST PATCH, a stale browser tab and a restore all get the
--   same rule, so a request already in flight is never newly blocked. The
--   requirements stored before this paste (only possible when the app was
--   deployed first, when nothing could be refused) are re-stamped with the
--   paste's time, before the trigger is created.
--
-- PASTE / DEPLOY ORDER. Either order is safe; RECOMMENDED: deploy the app
-- first, then paste.
--   * App deployed, not pasted: no examination data can be recorded (the
--     fill route answers 503 not_migrated, said) and a configured requirement
--     never refuses an issue (a 42P01 / PGRST205 on the table reads as "not
--     migrated": the issue goes ahead, its audit row says the data could not
--     be checked) — today's path.
--   * Pasted, app not yet deployed: nothing reads or writes the table.
--   * No workspace has a requirement at the paste: the inventory counts the
--     drafting configurations already carrying an examinationScope key
--     (expected 0) and the requests open at the paste (a requirement binds
--     only requests filed after it is stored, so none of them is ever newly
--     blocked).
--
-- Not a widening of any existing authority: one new table, readable exactly
-- as its request is; no client gains a write; no SECURITY DEFINER; the
-- trigger only ever moves a requirement's start LATER than a writer asked
-- (never earlier). The counts-only inventory is captured first anyway
-- (DEC-30).
-- Re-runnable: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP … IF
-- EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NULL OR to_regclass('public.org_configurations') IS NULL THEN
    RAISE EXCEPTION '20261266 needs the tickets and org_configurations tables; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_266_before;
CREATE TEMP TABLE df_round_g_266_before AS
SELECT 1 AS ord, 'inventory (before apply): workspaces whose request-form configuration already carries an examinationScope key (expected 0 — none means no requirement and no gate anywhere)' AS inventory,
       COUNT(*)::text AS n
  FROM org_configurations
 WHERE key = 'drafting' AND jsonb_typeof(data) = 'object' AND data ? 'examinationScope'
UNION ALL
SELECT 2, 'inventory (before apply): requests open at the paste (not closed, canceled or archived) — a requirement binds only requests filed after it is stored, so none of these is ever newly blocked (each shows what is missing as a warning)',
       COUNT(*)::text
  FROM tickets
 WHERE status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL
UNION ALL
SELECT 3, 'inventory (before apply): examination-data requirements already stored (expected 0 — any found were saved before this paste, when nothing could be refused; each is re-stamped with the paste''s time)',
       COUNT(*)::text
  FROM org_configurations c
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data) = 'object' AND jsonb_typeof(c.data->'examinationScope') = 'object'
                                                   AND jsonb_typeof(c.data->'examinationScope'->'requirements') = 'array'
                                              THEN c.data->'examinationScope'->'requirements' ELSE '[]'::jsonb END) AS r(req)
 WHERE c.key = 'drafting';

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_examination_scopes (
  ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  field_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  waiver JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  CONSTRAINT ticket_examination_scopes_values_object CHECK (jsonb_typeof(field_values) = 'object'),
  CONSTRAINT ticket_examination_scopes_waiver_object CHECK (waiver IS NULL OR jsonb_typeof(waiver) = 'object')
);
CREATE INDEX IF NOT EXISTS ticket_examination_scopes_org_idx ON ticket_examination_scopes (org_id);

CREATE OR REPLACE FUNCTION ticket_examination_scopes_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    RAISE EXCEPTION 'a request''s examination data stays with its request.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = NEW.ticket_id AND t.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'a request''s examination data belongs to its request''s workspace.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ticket_examination_scopes_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_examination_scopes_guard ON ticket_examination_scopes;
CREATE TRIGGER trg_ticket_examination_scopes_guard
BEFORE INSERT OR UPDATE ON ticket_examination_scopes
FOR EACH ROW EXECUTE FUNCTION ticket_examination_scopes_guard();

ALTER TABLE ticket_examination_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_examination_scopes_read ON ticket_examination_scopes;
CREATE POLICY ticket_examination_scopes_read ON ticket_examination_scopes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_examination_scopes.ticket_id AND t.org_id = ticket_examination_scopes.org_id));
GRANT SELECT ON ticket_examination_scopes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_examination_scopes TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_examination_scopes FROM anon, authenticated;
REVOKE ALL ON ticket_examination_scopes FROM anon;

-- ── A requirement's `since` is the database's time (DF-P24 second fix pass) ─
-- The requirements stored before this paste carry whatever a client wrote:
-- each is re-stamped with the paste's time (nothing was refused before the
-- paste — the table above did not exist). On a first paste this runs before
-- the trigger exists; on a re-paste the trigger keeps each stored time.
UPDATE org_configurations c
   SET data = jsonb_set(c.data, '{examinationScope,requirements}',
         (SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(e.r) = 'object'
                                         THEN e.r || jsonb_build_object('since', to_char(date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                                         ELSE e.r END ORDER BY e.ord), '[]'::jsonb)
            FROM jsonb_array_elements(c.data->'examinationScope'->'requirements') WITH ORDINALITY AS e(r, ord)))
 WHERE c.key = 'drafting' AND jsonb_typeof(c.data) = 'object'
   AND jsonb_typeof(c.data->'examinationScope') = 'object'
   AND jsonb_typeof(c.data->'examinationScope'->'requirements') = 'array';

-- Every write of the 'drafting' row: each requirement's `since` is decided
-- here, never taken from the writer. Kept only for a requirement whose
-- identity (field, work class, library — trimmed as lib/examinationScope.ts
-- trims, JavaScript's whitespace) is stored in the row being replaced, whose
-- field had a value to pick from THERE (the first valid field with that key
-- among the first 50, an option with a non-blank value among its first 200 —
-- the parser's own reading), and whose stored time is in this function's
-- own format. Otherwise: the database's clock plus one minute, to the
-- second. Requirements are never added, dropped or reordered.
CREATE OR REPLACE FUNCTION drafting_examination_scope_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  trim_re CONSTANT text := '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$';
  v_stamp CONSTANT text := to_char(date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_old_scope jsonb;
  v_out jsonb := '[]'::jsonb;
  v_req jsonb;
  v_f jsonb;
  v_key text;
  v_field text;
  v_wc text;
  v_lib text;
  v_fillable boolean;
  v_kept text;
BEGIN
  IF NEW.key IS DISTINCT FROM 'drafting' OR jsonb_typeof(NEW.data) IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.data->'examinationScope') IS DISTINCT FROM 'object'
     OR jsonb_typeof(NEW.data->'examinationScope'->'requirements') IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.key = 'drafting' AND OLD.org_id = NEW.org_id
     AND jsonb_typeof(OLD.data) = 'object' AND jsonb_typeof(OLD.data->'examinationScope') = 'object' THEN
    v_old_scope := OLD.data->'examinationScope';
  END IF;
  FOR v_req IN SELECT e.r FROM jsonb_array_elements(NEW.data->'examinationScope'->'requirements') WITH ORDINALITY AS e(r, ord) ORDER BY e.ord LOOP
    IF jsonb_typeof(v_req) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_array(v_req);
      CONTINUE;
    END IF;
    v_kept := NULL;
    IF v_old_scope IS NOT NULL AND jsonb_typeof(v_old_scope->'fields') = 'array' AND jsonb_typeof(v_old_scope->'requirements') = 'array' THEN
      v_field := CASE WHEN jsonb_typeof(v_req->'field') = 'string' THEN regexp_replace(v_req->>'field', trim_re, '', 'g') ELSE '' END;
      v_wc := CASE WHEN jsonb_typeof(v_req->'workClass') = 'string' THEN regexp_replace(v_req->>'workClass', trim_re, '', 'g') ELSE '' END;
      v_lib := CASE WHEN jsonb_typeof(v_req->'libraryId') = 'string' THEN regexp_replace(v_req->>'libraryId', trim_re, '', 'g') ELSE '' END;
      v_fillable := false;
      IF v_field <> '' THEN
        FOR v_f IN SELECT e.f FROM jsonb_array_elements(v_old_scope->'fields') WITH ORDINALITY AS e(f, ord) WHERE e.ord <= 50 ORDER BY e.ord LOOP
          CONTINUE WHEN jsonb_typeof(v_f) IS DISTINCT FROM 'object' OR jsonb_typeof(v_f->'key') IS DISTINCT FROM 'string';
          v_key := regexp_replace(v_f->>'key', trim_re, '', 'g');
          CONTINUE WHEN v_key !~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$';
          IF v_key = v_field THEN
            v_fillable := jsonb_typeof(v_f->'options') = 'array' AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_f->'options') WITH ORDINALITY AS o(op, n)
               WHERE o.n <= 200 AND jsonb_typeof(o.op) = 'object' AND jsonb_typeof(o.op->'value') = 'string'
                 AND regexp_replace(o.op->>'value', trim_re, '', 'g') <> '');
            EXIT;
          END IF;
        END LOOP;
      END IF;
      IF v_fillable THEN
        SELECT max(o.r->>'since') INTO v_kept
          FROM jsonb_array_elements(v_old_scope->'requirements') AS o(r)
         WHERE jsonb_typeof(o.r) = 'object'
           AND jsonb_typeof(o.r->'since') = 'string'
           AND o.r->>'since' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
           AND (CASE WHEN jsonb_typeof(o.r->'field') = 'string' THEN regexp_replace(o.r->>'field', trim_re, '', 'g') ELSE '' END) = v_field
           AND (CASE WHEN jsonb_typeof(o.r->'workClass') = 'string' THEN regexp_replace(o.r->>'workClass', trim_re, '', 'g') ELSE '' END) = v_wc
           AND (CASE WHEN jsonb_typeof(o.r->'libraryId') = 'string' THEN regexp_replace(o.r->>'libraryId', trim_re, '', 'g') ELSE '' END) = v_lib;
      END IF;
    END IF;
    v_out := v_out || jsonb_build_array(v_req || jsonb_build_object('since', COALESCE(v_kept, v_stamp)));
  END LOOP;
  NEW.data := jsonb_set(NEW.data, '{examinationScope,requirements}', v_out);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION drafting_examination_scope_stamp() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_org_config_examination_scope_stamp ON org_configurations;
CREATE TRIGGER trg_org_config_examination_scope_stamp
BEFORE INSERT OR UPDATE ON org_configurations
FOR EACH ROW WHEN (NEW.key = 'drafting')
EXECUTE FUNCTION drafting_examination_scope_stamp();

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'ticket_examination_scopes exists: one row per request (ticket_id primary key, cascading), its workspace, the values object and the waiver'::text AS check,
       (to_regclass('public.ticket_examination_scopes') IS NOT NULL
        AND (SELECT COUNT(*) = 6 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ticket_examination_scopes'
                AND column_name IN ('ticket_id', 'org_id', 'field_values', 'waiver', 'updated_at', 'updated_by'))
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_pkey')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_values_object')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_waiver_object')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'row level security is on; ONE policy, a SELECT read as the request reads; no write policy',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_examination_scopes'::regclass), false)
       AND (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_examination_scopes' AND cmd = 'SELECT'
             AND qual LIKE '%FROM tickets t%' AND qual LIKE '%t.org_id = ticket_examination_scopes.org_id%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_examination_scopes' AND cmd <> 'SELECT'),
       NULL
UNION ALL
SELECT 1, 3, 'no client writes it: authenticated holds no INSERT / UPDATE / DELETE grant, anon not even SELECT; the service role writes',
       has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_examination_scopes', 'SELECT')
       AND has_table_privilege('service_role', 'public.ticket_examination_scopes', 'INSERT')
       AND has_table_privilege('service_role', 'public.ticket_examination_scopes', 'UPDATE'),
       NULL
UNION ALL
SELECT 1, 4, 'the guard keeps each row in its request''s workspace and its request fixed (SECURITY INVOKER, search_path pinned, executable by no client role; enabled)',
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   AND p.prosrc LIKE '%t.org_id = NEW.org_id%' AND p.prosrc LIKE '%NEW.ticket_id IS DISTINCT FROM OLD.ticket_id%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'ticket_examination_scopes_guard'), false)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_examination_scopes_guard' AND NOT tgisinternal AND tgenabled = 'O')
       AND NOT has_function_privilege('authenticated', 'public.ticket_examination_scopes_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_examination_scopes_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 5, 'a requirement''s time is the database''s, never a writer''s: the stamp trigger on the drafting row (SECURITY INVOKER, search_path pinned, executable by no client role; BEFORE INSERT OR UPDATE, enabled)',
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   AND p.prosrc LIKE '%COALESCE(v_kept, v_stamp)%' AND p.prosrc LIKE '%OLD.org_id = NEW.org_id%'
                   AND p.prosrc LIKE '%interval ''60 seconds''%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'drafting_examination_scope_stamp'), false)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_config_examination_scope_stamp' AND tgrelid = 'public.org_configurations'::regclass
                     AND NOT tgisinternal AND tgenabled = 'O' AND tgqual IS NOT NULL
                     AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE ON public.org_configurations FOR EACH ROW WHEN %drafting% EXECUTE FUNCTION drafting_examination_scope_stamp()%')
       AND NOT has_function_privilege('authenticated', 'public.drafting_examination_scope_stamp()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.drafting_examination_scope_stamp()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 6, 'every stored requirement carries a time in the database''s format (any stored before this paste re-stamped with the paste''s time)',
       NOT EXISTS (SELECT 1 FROM org_configurations c
                    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.data) = 'object' AND jsonb_typeof(c.data->'examinationScope') = 'object'
                                                                      AND jsonb_typeof(c.data->'examinationScope'->'requirements') = 'array'
                                                                 THEN c.data->'examinationScope'->'requirements' ELSE '[]'::jsonb END) AS r(req)
                    WHERE c.key = 'drafting' AND jsonb_typeof(r.req) = 'object'
                      AND NOT (jsonb_typeof(r.req->'since') = 'string' AND r.req->>'since' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_266_before
UNION ALL
SELECT 3, 1, 'after: requests with examination data on record (0 right after the first paste)', NULL,
       (SELECT COUNT(*) FROM ticket_examination_scopes)::text
) AS final_rows
ORDER BY sec, ord;
