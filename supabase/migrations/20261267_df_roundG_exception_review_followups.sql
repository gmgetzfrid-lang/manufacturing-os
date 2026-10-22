-- ─────────────────────────────────────────────────────────────────────────────
-- 20261267_df_roundG_exception_review_followups.sql
--
-- drafting-flow Round G — DF-P25 EXCEPTION-ONLY REVIEW AND PRE-AUTHORIZATION
-- FOLLOW-UPS (DEC-90 rulings for DF-P25: industry best practice, fail-safe,
-- no regression). One DEC-30 paste, four sections, nothing renamed:
--
--   (1) MEMBERSHIP CONTINUITY (the DF-P22 follow-up (a)). org_members gains
--       status_changed_at (TIMESTAMPTZ, NULL for every existing row — NULL
--       means "not changed since this column existed"). A BEFORE INSERT OR
--       UPDATE trigger (org_members_status_change_stamp, SECURITY INVOKER,
--       search_path pinned, executable by no client role) owns it: an INSERT
--       lands NULL; an UPDATE that changes `status` — whoever writes it: the
--       Admin screen, revoke_member, the API, SQL — stamps the time; every
--       other UPDATE keeps the stored value, whatever the writer sent. So a
--       status flipped straight on the table and flipped back, with no audit
--       row, is a stored fact a standing pre-authorization's continuity check
--       reads (lib/ticketPreauthorization.ts preauthGrantorMembership; the
--       membership audit rows stay the second source).
--       apply_ticket_preauthorizations is RE-CREATED from its newest body
--       (20261264 §5) with ONE added condition in its clause (c): the
--       grantor's row has no status change stamped at or after the record's
--       creation (`m.status_changed_at IS NULL OR m.status_changed_at <
--       p.created_at`) — pinned by a lineDiff test. Grants unchanged (the
--       service role only).
--   (2) EVID-1 actorId (the DF-P23 follow-up (a)). A NEW, separate trigger
--       on tickets — trg_ticket_history_actor_guard, BEFORE UPDATE OF history
--       (ticket_history_actor_guard, SECURITY INVOKER, search_path pinned,
--       executable by no client role) — checks ONLY the entries a client
--       statement appends: each may carry no actorId (absent or JSON null)
--       or one equal to auth.uid(); anything else is refused 42501. A
--       statement whose current_user is not a client role (authenticated /
--       anon) passes untouched: the service role (every server route, which
--       takes actorId from the session) and a SECURITY DEFINER path (its
--       owner). ticket_update_guard is NOT re-created: its newest body
--       (20261250) is pending as a HOLD (MIGRATION-PASTE-ORDER row 194), so
--       this paste never depends on it, and it works with or without it.
--   (3) ticket_sla_escalations.recipients is DOCUMENTED (the DF-P22
--       follow-up (b)): a COMMENT that it is the audience the contact
--       resolved to who may read the request, written before the notice —
--       who was told is the audit row's details.recipients. No data change.
--   (4) GAP-102 ruling (2), the notify-only limb (the DF-P24 hand-off).
--       document_holds gains examination (JSONB, NULL for every existing
--       hold): what a notify-only assurance occupant examined, written in
--       the hold's OWN insert (lib/holds.ts openHold), so the record and the
--       act cannot disagree. A CHECK keeps it a JSON object of bounded size
--       (or NULL); a NEW trigger (document_hold_examination_fixed, BEFORE
--       UPDATE OF examination, SECURITY INVOKER, search_path pinned) refuses
--       any change to it once written, for every role. A second NEW trigger
--       (document_hold_examination_opener, BEFORE INSERT, SECURITY INVOKER,
--       search_path pinned) ties the record to its writer: a client role's
--       insert that carries a record is refused 42501 unless the hold is
--       placed in the caller's own name (opened_by = auth.uid()) — so a
--       record can never be written in another person's name. The service
--       role (a restore, a server route) and a SECURITY DEFINER path pass
--       untouched; a hold without a record is not looked at. 20261073's
--       guards are NOT re-created (column-only checks): every existing hold,
--       and every hold placed without a record, behaves exactly as before.
--
-- NOT a widening: nobody gains a read or a write. (1) stamps a fact and
-- narrows when a pre-authorization is in force; (2) refuses a client's
-- forged actorId; (3) is a comment; (4) adds a column a person writes only
-- with a hold placed in their own name (the hold's existing INSERT policy
-- and guards decide who may place one, unchanged), refuses a record on a
-- hold opened in another uid's name, and refuses its rewrite. The counts-only
-- inventory is captured first anyway (DEC-30).
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261264 (the first statement refuses,
-- changing nothing, without its function and table). Either order with the
-- DF-P25 deploy is safe; RECOMMENDED: deploy the app FIRST, then paste.
--   * App deployed, not pasted: the continuity check reads org_members
--     without status_changed_at (42703 / PGRST204 → today's read, the audit
--     rows decide, said in the record); a hold placed with a record retries
--     without the column (PGRST204) and is placed, the panel saying the
--     record was not stored; the panel reads holds without the column (42703
--     → "not recorded until 20261267"); a client append is checked by the
--     tickets guards that are pasted, as today.
--   * Pasted, app not deployed: the stamp, the actor check and the CHECK act
--     on writes the old app makes — none of which carries an actorId on a
--     client append or an examination on a hold, so nothing it does changes.
--   * NEVER re-paste 20261264 after this file without pasting this file
--     again right after: 20261264 restores apply_ticket_preauthorizations'
--     earlier body (nothing breaks — the app's own continuity check still
--     reads the stamp — but the database's re-check no longer does).
-- Independent of every other pending migration (ticket_update_guard and
-- 20261073's guards are untouched; 20261166 / 20261221 / 20261250 may be
-- pasted before or after).
-- Re-runnable: ADD COLUMN IF NOT EXISTS (a stored stamp or record is kept),
-- CREATE OR REPLACE, DROP … IF EXISTS, the CHECK dropped and re-added.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.ticket_preauthorizations') IS NULL
     OR to_regclass('public.ticket_sla_escalations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                     WHERE ns.nspname = 'public' AND p.proname = 'apply_ticket_preauthorizations') THEN
    RAISE EXCEPTION '20261267 needs 20261264 (standing pre-authorization, with apply_ticket_preauthorizations) pasted first; nothing was changed.';
  END IF;
  IF to_regclass('public.org_members') IS NULL OR to_regclass('public.tickets') IS NULL OR to_regclass('public.document_holds') IS NULL THEN
    RAISE EXCEPTION '20261267 needs org_members, tickets and document_holds; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_267_before;
CREATE TEMP TABLE df_round_g_267_before AS
SELECT 1 AS ord, 'inventory (before apply): workspace memberships (org_members rows) — each keeps its status_changed_at, NULL on a first paste ("not changed since the column existed"; the membership audit rows still decide what came before)' AS inventory,
       COUNT(*)::text AS n
  FROM org_members
UNION ALL
SELECT 2, 'inventory (before apply): memberships not active now — any standing pre-authorization of theirs is already not in force',
       COUNT(*)::text FROM org_members WHERE status IS DISTINCT FROM 'active'
UNION ALL
SELECT 3, 'inventory (before apply): standing pre-authorizations in force (not revoked, not expired) — from this paste a status change of their grantor is seen at once, whoever makes it',
       COUNT(*)::text FROM ticket_preauthorizations WHERE revoked_at IS NULL AND expires_at > now()
UNION ALL
SELECT 4, 'inventory (before apply): requests whose history already names an actorId on some entry — none is changed (only entries a client appends from now on are checked)',
       COUNT(*)::text FROM tickets
 WHERE jsonb_typeof(history) = 'array' AND jsonb_path_exists(history, '$[*] ? (exists(@.actorId))')
UNION ALL
SELECT 5, 'inventory (before apply): document holds — each without an examination record; none is changed',
       COUNT(*)::text FROM document_holds
UNION ALL
SELECT 6, 'inventory (before apply): routing tables (libraries + folders + documents) storing records_examination on a NOTIFY-ONLY slot (expected 0 — the editor never wrote one; from the DF-P25 deploy such an opt-in is honoured: its occupants may stop the request with a hold that records what they examined)',
       ((SELECT COUNT(*) FROM libraries WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "notify_only" && @.records_examination == true)'))
      + (SELECT COUNT(*) FROM collections WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "notify_only" && @.records_examination == true)'))
      + (SELECT COUNT(*) FROM documents WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.mode == "notify_only" && @.records_examination == true)')))::text;

BEGIN;

-- ── 1. membership continuity: a status change is a stored fact ──────────────
ALTER TABLE org_members ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
COMMENT ON COLUMN org_members.status_changed_at IS
  'When this membership''s status last changed (DF-P25, 20261267) — stamped by trg_org_members_status_changed on every status change, whoever writes it (the app, revoke_member, the API, SQL); kept on every other write; NULL on insert. NULL = not changed since the column existed. A standing pre-authorization is in force only while its grantor has no status change at or after the record''s creation.';

CREATE OR REPLACE FUNCTION org_members_status_change_stamp()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := clock_timestamp();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION org_members_status_change_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_org_members_status_changed ON org_members;
CREATE TRIGGER trg_org_members_status_changed
  BEFORE INSERT OR UPDATE ON org_members
  FOR EACH ROW EXECUTE FUNCTION org_members_status_change_stamp();

-- apply_ticket_preauthorizations — re-created from its NEWEST body (20261264
-- §5) with one added condition in clause (c) (lineDiff-pinned).
CREATE OR REPLACE FUNCTION apply_ticket_preauthorizations(
  p_ticket_id UUID, p_org_id UUID, p_expected_last_modified TIMESTAMPTZ, p_preauthorization_ids UUID[],
  p_metadata JSONB, p_history JSONB, p_last_modified TIMESTAMPTZ, p_unread_by UUID[])
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_ids UUID[];
  v_grantors UUID[];
  v_live UUID[];
  v_n INTEGER;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_ids
    FROM unnest(p_preauthorization_ids) AS x WHERE x IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'apply_ticket_preauthorizations: no standing pre-authorization named; nothing was changed.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- (a) the grantors' membership rows, held until this transaction ends
  SELECT COALESCE(array_agg(DISTINCT p.grantor_id), '{}') INTO v_grantors
    FROM ticket_preauthorizations p WHERE p.id = ANY (v_ids) AND p.org_id = p_org_id;
  PERFORM 1 FROM org_members m
    WHERE m.org_id = p_org_id AND m.uid = ANY (v_grantors)
    ORDER BY m.uid
    FOR SHARE;
  -- (b) the records, held until this transaction ends, re-checked on the
  --     rows locked: not revoked, not expired
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_live FROM (
    SELECT p.id FROM ticket_preauthorizations p
     WHERE p.id = ANY (v_ids) AND p.org_id = p_org_id AND p.revoked_at IS NULL AND p.expires_at > now()
     ORDER BY p.id
       FOR SHARE) AS s;
  -- (c) the grantor an ACTIVE member continuously since the record was
  --     created: the membership row no newer than the record (a member
  --     removed and re-added has a new row), no status change stamped on it
  --     since (status_changed_at — 20261267, any writer) and no membership
  --     status audit row of theirs since (revoke_member writes it with the
  --     status change)
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_live
    FROM ticket_preauthorizations p
   WHERE p.id = ANY (v_live)
     AND EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p.org_id AND m.uid = p.grantor_id AND m.status = 'active'
                    AND m.created_at IS NOT NULL AND m.created_at <= p.created_at
                    AND (m.status_changed_at IS NULL OR m.status_changed_at < p.created_at))
     AND NOT EXISTS (SELECT 1 FROM audit_logs a
                      WHERE a.org_id = p.org_id AND a.resource_id = p.grantor_id::text
                        AND a.action IN ('MEMBER_SUSPENDED', 'MEMBER_REMOVED', 'MEMBER_RESTORED', 'MEMBER_REACTIVATED')
                        AND (a.timestamp IS NULL OR a.timestamp >= p.created_at));
  IF cardinality(v_live) < cardinality(v_ids) THEN
    RETURN jsonb_build_object('result', 'not_in_force',
      'gone', (SELECT COALESCE(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM unnest(v_ids) AS x WHERE NOT (x = ANY (v_live))));
  END IF;
  -- (d) the compare-and-set on the request (a person who acted first wins)
  UPDATE tickets
     SET metadata = p_metadata, history = p_history, last_modified = p_last_modified,
         unread_by = COALESCE(p_unread_by, unread_by)
   WHERE id = p_ticket_id AND org_id = p_org_id AND status = 'PENDING_REVIEW'
     AND last_modified IS NOT DISTINCT FROM p_expected_last_modified;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('result', CASE WHEN v_n = 1 THEN 'applied' ELSE 'conflict' END);
END;
$$;

REVOKE ALL ON FUNCTION apply_ticket_preauthorizations(UUID, UUID, TIMESTAMPTZ, UUID[], JSONB, JSONB, TIMESTAMPTZ, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_ticket_preauthorizations(UUID, UUID, TIMESTAMPTZ, UUID[], JSONB, JSONB, TIMESTAMPTZ, UUID[]) TO service_role;

-- ── 2. EVID-1: a client's own history append names only the client ─────────
CREATE OR REPLACE FUNCTION ticket_history_actor_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_old_len INT;
  v_entry JSONB;
  v_actor TEXT;
BEGIN
  -- Only a client role's own statement is checked. The service role (every
  -- server route — they take actorId from the session) and a SECURITY
  -- DEFINER path (current_user is its owner) pass untouched.
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.history) IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
  v_old_len := CASE WHEN jsonb_typeof(OLD.history) = 'array' THEN jsonb_array_length(OLD.history) ELSE 0 END;
  FOR v_entry IN SELECT h.value FROM jsonb_array_elements(NEW.history) WITH ORDINALITY AS h
                  WHERE h.ordinality > v_old_len LOOP
    IF jsonb_typeof(v_entry) = 'object' AND v_entry ? 'actorId' AND jsonb_typeof(v_entry -> 'actorId') <> 'null' THEN
      v_actor := CASE WHEN jsonb_typeof(v_entry -> 'actorId') = 'string' THEN lower(v_entry ->> 'actorId') END;
      IF v_actor IS NULL OR auth.uid() IS NULL OR v_actor <> auth.uid()::text THEN
        RAISE EXCEPTION 'tickets: a history entry you add may name only you as its actor (actorId)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ticket_history_actor_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ticket_history_actor_guard ON tickets;
CREATE TRIGGER trg_ticket_history_actor_guard
  BEFORE UPDATE OF history ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_history_actor_guard();

-- ── 3. the escalation claim's recipients, documented ────────────────────────
COMMENT ON COLUMN ticket_sla_escalations.recipients IS
  'The escalation contact''s people who may read the request — the audience asked, written with the claim BEFORE the notice is sent (DF-P22). Who was actually told is the TICKET_SLA_ESCALATED audit row''s details.recipients; when that row could not be written, the maintenance run''s report names them (DF-P25).';

-- ── 4. GAP-102 notify-only limb: what a hold's opener examined ───────────────
ALTER TABLE document_holds ADD COLUMN IF NOT EXISTS examination JSONB;
COMMENT ON COLUMN document_holds.examination IS
  'DF-P25 (GAP-102 ruling (2), 20261267): what a notify-only assurance occupant examined, written in the hold''s own insert by the person placing it (lib/holds.ts openHold) — the request, its review round, the files and their recorded hashes, the note. NULL = a hold placed without a record (every hold before this column). Never changed once written.';
ALTER TABLE document_holds DROP CONSTRAINT IF EXISTS document_holds_examination_shape;
ALTER TABLE document_holds ADD CONSTRAINT document_holds_examination_shape
  CHECK (examination IS NULL OR (jsonb_typeof(examination) = 'object' AND octet_length(examination::text) <= 32768));

CREATE OR REPLACE FUNCTION document_hold_examination_fixed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.examination IS DISTINCT FROM OLD.examination THEN
    RAISE EXCEPTION 'document_holds: the record of what was examined is written with the hold and never changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION document_hold_examination_fixed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_document_hold_examination_fixed ON document_holds;
CREATE TRIGGER trg_document_hold_examination_fixed
  BEFORE UPDATE OF examination ON document_holds
  FOR EACH ROW EXECUTE FUNCTION document_hold_examination_fixed();

-- The record names who examined only through the hold's opener, so a client
-- may write a record only on a hold placed in its own name. (opened_by is
-- pinned once placed by 20261073's guard, so the insert is the one place to
-- check it.) Column-only: a hold without a record is not looked at.
CREATE OR REPLACE FUNCTION document_hold_examination_opener()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  -- Only a client role's own statement is checked. The service role (a
  -- restore, a server route) and a SECURITY DEFINER path pass untouched.
  IF NEW.examination IS NOT NULL AND current_user IN ('authenticated', 'anon')
     AND (auth.uid() IS NULL OR NEW.opened_by IS DISTINCT FROM auth.uid()) THEN
    RAISE EXCEPTION 'document_holds: a record of what was examined goes only on a hold you place in your own name (opened_by)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION document_hold_examination_opener() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_document_hold_examination_opener ON document_holds;
CREATE TRIGGER trg_document_hold_examination_opener
  BEFORE INSERT ON document_holds
  FOR EACH ROW EXECUTE FUNCTION document_hold_examination_opener();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 8 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'DF-P22 follow-up (a): org_members.status_changed_at exists (timestamptz, nullable)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'org_members' AND column_name = 'status_changed_at'
                  AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'every org_members status change is stamped, whoever writes it (BEFORE INSERT OR UPDATE trigger, enabled; SECURITY INVOKER, search_path pinned; no client EXECUTE)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_org_members_status_changed' AND tgrelid = 'public.org_members'::regclass AND NOT tgisinternal AND tgenabled = 'O')
       AND COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                       AND p.prosrc LIKE '%NEW.status IS DISTINCT FROM OLD.status%' AND p.prosrc LIKE '%NEW.status_changed_at := OLD.status_changed_at%'
                       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = 'org_members_status_change_stamp'), false)
       AND NOT has_function_privilege('authenticated', 'public.org_members_status_change_stamp()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 3, 'apply_ticket_preauthorizations re-checks the grantor''s stamped status change too (and everything 20261264 checked); SECURITY INVOKER, search_path pinned; only the service role executes it',
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   AND p.prosrc LIKE '%m.status_changed_at IS NULL OR m.status_changed_at < p.created_at%'
                   AND p.prosrc LIKE '%FOR SHARE%' AND p.prosrc LIKE '%p.revoked_at IS NULL%'
                   AND p.prosrc LIKE '%m.created_at <= p.created_at%' AND p.prosrc LIKE '%MEMBER_RESTORED%'
                   AND p.prosrc LIKE '%last_modified IS NOT DISTINCT FROM p_expected_last_modified%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'apply_ticket_preauthorizations'), false)
       AND has_function_privilege('service_role', 'public.apply_ticket_preauthorizations(uuid, uuid, timestamptz, uuid[], jsonb, jsonb, timestamptz, uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.apply_ticket_preauthorizations(uuid, uuid, timestamptz, uuid[], jsonb, jsonb, timestamptz, uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.apply_ticket_preauthorizations(uuid, uuid, timestamptz, uuid[], jsonb, jsonb, timestamptz, uuid[])', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 4, 'EVID-1 (DF-P23 follow-up (a)): a client''s appended history entry names no actorId or its own (BEFORE UPDATE OF history trigger, enabled; SECURITY INVOKER, search_path pinned; no client EXECUTE); ticket_update_guard untouched',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_history_actor_guard' AND tgrelid = 'public.tickets'::regclass AND NOT tgisinternal AND tgenabled = 'O')
       AND COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                       AND p.prosrc LIKE '%actorId%' AND p.prosrc LIKE '%current_user NOT IN (''authenticated'', ''anon'')%'
                       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = 'ticket_history_actor_guard'), false)
       AND NOT has_function_privilege('authenticated', 'public.ticket_history_actor_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 5, 'DF-P22 follow-up (b): ticket_sla_escalations.recipients says it is the audience asked, not the people told',
       COALESCE(col_description('public.ticket_sla_escalations'::regclass,
         (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.ticket_sla_escalations'::regclass AND attname = 'recipients')) LIKE '%audience asked%', false),
       NULL
UNION ALL
SELECT 1, 6, 'GAP-102 notify-only limb: document_holds.examination exists (jsonb, nullable) and is an object of bounded size or NULL (CHECK)',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'document_holds' AND column_name = 'examination' AND data_type = 'jsonb' AND is_nullable = 'YES')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_holds_examination_shape'
                     AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(examination)%'),
       NULL
UNION ALL
SELECT 1, 7, 'a hold''s examination record is never changed once written (BEFORE UPDATE OF examination trigger, enabled; SECURITY INVOKER, search_path pinned; no client EXECUTE)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_hold_examination_fixed' AND tgrelid = 'public.document_holds'::regclass AND NOT tgisinternal AND tgenabled = 'O')
       AND COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = 'document_hold_examination_fixed'), false)
       AND NOT has_function_privilege('authenticated', 'public.document_hold_examination_fixed()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 8, 'a client may write an examination record only on a hold placed in its own name — opened_by = auth.uid() (BEFORE INSERT trigger, enabled; SECURITY INVOKER, search_path pinned; no client EXECUTE)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_hold_examination_opener' AND tgrelid = 'public.document_holds'::regclass AND NOT tgisinternal AND tgenabled = 'O')
       AND COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                       AND p.prosrc LIKE '%NEW.opened_by IS DISTINCT FROM auth.uid()%' AND p.prosrc LIKE '%current_user IN (''authenticated'', ''anon'')%'
                       FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                      WHERE ns.nspname = 'public' AND p.proname = 'document_hold_examination_opener'), false)
       AND NOT has_function_privilege('authenticated', 'public.document_hold_examination_opener()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_267_before
UNION ALL
SELECT 3, 1, 'after: memberships with a status change stamped (0 right after a first paste; a re-paste keeps every stamp)', NULL,
       (SELECT COUNT(*) FROM org_members WHERE status_changed_at IS NOT NULL)::text
UNION ALL
SELECT 3, 2, 'after: holds carrying an examination record (0 right after a first paste)', NULL,
       (SELECT COUNT(*) FROM document_holds WHERE examination IS NOT NULL)::text
) AS final_rows
ORDER BY sec, ord;
