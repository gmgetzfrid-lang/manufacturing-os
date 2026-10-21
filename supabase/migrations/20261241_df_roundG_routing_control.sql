-- ─────────────────────────────────────────────────────────────────────────────
-- 20261241_df_roundG_routing_control.sql
--
-- drafting-flow Round G — DF-P5 ROSTER: the routing table (GAP-112; DEC-35,
-- DEC-36, DEC-37). Routing is DATA, declared per container exactly where its
-- neighbours review_control and doc_class already live, and resolved along
-- the one container chain (lib/containerChain.ts: document → folder →
-- ancestors → library, most specific DEFINED level wins).
--
--   (1) routing_control JSONB on libraries, collections and documents —
--       20261012's doc_class lines, line for line (ADD COLUMN IF NOT EXISTS;
--       COMMENT ON COLUMN). NULL = inherit; a NULL chain = unconfigured:
--       today's routing, exactly. Shape (validated by the app,
--       lib/routingControl.ts parseRoutingControl; the database only checks
--       it is an object):
--         { "slots": [ { "kind", "label"?, "mode": blocking | consent_window
--                        | notify_only, "fill": { roles | users | capability
--                        | identity: "requester" }, "alternates"?,
--                        "timeoutDays"?, "independent_of"?, "waivable_by"? } ] }
--   (2) No new policy (DEC-36): the column inherits each table's row
--       security. Who may WRITE it is decided by a guard, because a routing
--       table with a weaker guard than the roles it routes is worse than no
--       router (DEC-36, GAP-112 "a defect to fix before storing anything"):
--         * libraries, collections (folders) and documents — a document
--           controller ONLY (is_org_controller), on every level. A routing
--           table decides who reviews every ticket that cites the container,
--           so the drafter who is a document's effective owner, or the
--           drafting lead who owns or manages a library, must never be able
--           to swap the reviewers of their own deliverables (DF-P5 fix
--           passes 1 and 2: the library owner / node manager limb is gone —
--           the same swap stayed open one level up). The workflow route also
--           keeps the org-wide engineering gate on every routed roster
--           (lib/ticketRoster.ts withEngineeringGate), whoever wrote the table;
--         * INSERT on all three — a row born with a routing table needs a
--           document controller (a NULL column is not checked): the same
--           authority as a change, so a table can never be planted at
--           creation where it could not be written afterwards.
--       Service-role writes (restores, the app's server paths) pass.
--       enforce_routing_control_change() is NEW (no existing function is
--       re-created), SECURITY DEFINER, search_path pinned, EXECUTE revoked
--       from every client role (DRLS-16: a trigger function).
--   (3) Every routing_control change on every level — and every row INSERTED
--       carrying one — writes a ROUTING_CONTROL_CHANGED audit row from the
--       database — before (NULL on an insert) / after / level / who — in the
--       same transaction (audit_routing_control_change, NEW; the
--       review_control audit, 20261072, is not touched).
--
-- NOT A WIDENING: a new, empty column whose writes are guarded from the first
-- paste. Nobody gains a write they had. The counts-only inventory is
-- captured BEFORE the transaction (DEC-30) — no customer rows.
--
-- PASTE / DEPLOY ORDER. Independent of 20261242 in SQL, but paste 20261242
-- FIRST (or together): see the next sentences and 20261242's header. The
-- app carrying DF-P5 works BEFORE this paste (a routing_control read answers
-- 42703 / PGRST204 → every ticket is unconfigured: today's routing; the
-- routing editor says the update is not applied) and AFTER it (an
-- unconfigured workspace routes, notifies and gates exactly as today until a
-- controller declares a table). A table declared before 20261242 is pasted is
-- not used — the submission goes the usual way and says so (42P01 /
-- PGRST205 on the ledger) — and once 20261242 lands, such a request is a
-- routed review with no roster and needs a revision (TIER-5). Re-runnable: ADD COLUMN IF NOT EXISTS, the CHECK
-- is added only when missing, CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text).  ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_241_before;
CREATE TEMP TABLE df_round_g_241_before AS
SELECT 1 AS ord, 'inventory (before apply): libraries (each inherits NULL — unconfigured)' AS inventory, COUNT(*)::text AS n FROM libraries
UNION ALL
SELECT 2, 'inventory (before apply): folders (collections)', COUNT(*)::text FROM collections
UNION ALL
SELECT 3, 'inventory (before apply): documents', COUNT(*)::text FROM documents
UNION ALL
SELECT 4, 'inventory (before apply): libraries already carrying a routing_control (a re-paste; 0 on the first)',
       COUNT(*)::text FROM libraries l WHERE jsonb_typeof(to_jsonb(l) -> 'routing_control') = 'object'
UNION ALL
SELECT 5, 'inventory (before apply): open tickets with a library (they keep today''s path until a table is declared on their chain)',
       COUNT(*)::text FROM tickets t
 WHERE (to_jsonb(t) ->> 'library_id') IS NOT NULL AND t.status NOT IN ('CLOSED', 'CANCELED');

BEGIN;

-- ── 1. the column, 20261012's doc_class lines ──────────────────────────────
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS routing_control JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS routing_control JSONB;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS routing_control JSONB;

COMMENT ON COLUMN libraries.routing_control   IS 'Declared review routing (slots: kind, mode, fill, independent_of …). NULL = unconfigured (today''s routing).';
COMMENT ON COLUMN collections.routing_control IS 'Folder-level routing_control override. NULL = inherit from library.';
COMMENT ON COLUMN documents.routing_control   IS 'Document-level routing_control override. NULL = inherit from folder/library.';

-- An object or NULL — the app validates the slots (declared, never guessed).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['libraries', 'collections', 'documents'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_routing_control_object' AND conrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (routing_control IS NULL OR jsonb_typeof(routing_control) = ''object'')', t, t || '_routing_control_object');
    END IF;
  END LOOP;
END
$$;

-- ── 2. who may write it ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_routing_control_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    -- A row born with a routing table: a document controller only, on every level.
    IF NEW.routing_control IS NOT NULL AND NOT is_org_controller(NEW.org_id) THEN
      RAISE EXCEPTION 'Not permitted to create this % with a review routing table — only a document controller can declare one.',
        CASE TG_TABLE_NAME WHEN 'libraries' THEN 'library' WHEN 'collections' THEN 'folder' ELSE 'document' END
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.routing_control IS DISTINCT FROM OLD.routing_control THEN
    IF TG_TABLE_NAME = 'libraries' THEN
      IF NOT is_org_controller(OLD.org_id) THEN
        RAISE EXCEPTION 'Not permitted to change this library''s review routing — only a document controller can.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_TABLE_NAME = 'collections' THEN
      IF NOT is_org_controller(OLD.org_id) THEN
        RAISE EXCEPTION 'Not permitted to change this folder''s review routing — only a document controller can.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_TABLE_NAME = 'documents' THEN
      IF NOT is_org_controller(OLD.org_id) THEN
        RAISE EXCEPTION 'Not permitted to change this document''s review routing — only a document controller can.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_routing_control_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_library_routing_control_guard ON libraries;
CREATE TRIGGER trg_library_routing_control_guard
BEFORE INSERT OR UPDATE ON libraries
FOR EACH ROW EXECUTE FUNCTION enforce_routing_control_change();

DROP TRIGGER IF EXISTS trg_collection_routing_control_guard ON collections;
CREATE TRIGGER trg_collection_routing_control_guard
BEFORE INSERT OR UPDATE ON collections
FOR EACH ROW EXECUTE FUNCTION enforce_routing_control_change();

DROP TRIGGER IF EXISTS trg_document_routing_control_guard ON documents;
CREATE TRIGGER trg_document_routing_control_guard
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_routing_control_change();

-- ── 3. every change leaves an audit row ─────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_routing_control_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email  text;
  v_role   text;
  v_before jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.routing_control IS NULL THEN RETURN NEW; END IF;
    v_before := NULL;
  ELSIF NEW.routing_control IS DISTINCT FROM OLD.routing_control THEN
    v_before := OLD.routing_control;
  ELSE
    RETURN NEW;
  END IF;
  -- The writer's ROLE COLLECTION, never the headline alone.
  SELECT email, array_to_string(COALESCE(roles, ARRAY[role]), ',') INTO v_email, v_role FROM org_members
   WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES ('ROUTING_CONTROL_CHANGED',
          CASE TG_TABLE_NAME WHEN 'libraries' THEN 'library' WHEN 'collections' THEN 'collection' ELSE 'document' END,
          NEW.id::text, NEW.org_id, auth.uid(), v_email, v_role,
          jsonb_build_object('via', CASE WHEN auth.uid() IS NULL THEN 'service_role' ELSE 'database' END,
                             'op', lower(TG_OP), 'before', v_before, 'after', NEW.routing_control));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION audit_routing_control_change() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_libraries_routing_control_audit ON libraries;
CREATE TRIGGER trg_libraries_routing_control_audit
AFTER INSERT OR UPDATE ON libraries
FOR EACH ROW EXECUTE FUNCTION audit_routing_control_change();

DROP TRIGGER IF EXISTS trg_collections_routing_control_audit ON collections;
CREATE TRIGGER trg_collections_routing_control_audit
AFTER INSERT OR UPDATE ON collections
FOR EACH ROW EXECUTE FUNCTION audit_routing_control_change();

DROP TRIGGER IF EXISTS trg_documents_routing_control_audit ON documents;
CREATE TRIGGER trg_documents_routing_control_audit
AFTER INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION audit_routing_control_change();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 6 on a correct paste. Inventory rows: n = the count.
SELECT 'GAP-112: routing_control JSONB on libraries, collections and documents, each an object or NULL' AS check,
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'routing_control' AND data_type = 'jsonb'
           AND table_name IN ('libraries', 'collections', 'documents'))
       AND (SELECT COUNT(*) = 3 FROM pg_constraint
             WHERE conname IN ('libraries_routing_control_object', 'collections_routing_control_object', 'documents_routing_control_object')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'DEC-36: no new policy on libraries, collections or documents (the column inherits each table''s row security)',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename IN ('libraries', 'collections', 'documents')
                     AND (qual LIKE '%routing_control%' OR with_check LIKE '%routing_control%')),
       NULL
UNION ALL
SELECT 'the routing guard admits a document controller only — library, folder and document change, and any insert carrying a table (no owner / node-manager limb)',
       (SELECT prosrc LIKE '%is_org_controller(OLD.org_id)%'
           AND prosrc NOT LIKE '%can_manage_node%'
           AND prosrc NOT LIKE '%owner_user_id%'
           AND prosrc LIKE '%NEW.routing_control IS NOT NULL AND NOT is_org_controller(NEW.org_id)%'
           AND prosrc LIKE '%TG_TABLE_NAME = ''collections''%'
           AND prosrc NOT LIKE '%user_is_effective_owner%'
          FROM pg_proc WHERE proname = 'enforce_routing_control_change'),
       NULL
UNION ALL
SELECT 'guard triggers BEFORE INSERT OR UPDATE and audit triggers AFTER INSERT OR UPDATE on all three tables, enabled',
       (SELECT COUNT(*) = 6 FROM pg_trigger
         WHERE NOT tgisinternal AND tgenabled = 'O'
           AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
           AND tgname IN ('trg_library_routing_control_guard', 'trg_collection_routing_control_guard', 'trg_document_routing_control_guard',
                          'trg_libraries_routing_control_audit', 'trg_collections_routing_control_audit', 'trg_documents_routing_control_audit')),
       NULL
UNION ALL
SELECT 'DRLS-16: both functions SECURITY DEFINER with search_path pinned, EXECUTE revoked from anon and authenticated',
       (SELECT bool_and(prosecdef AND proconfig @> ARRAY['search_path=public'])
          FROM pg_proc WHERE proname IN ('enforce_routing_control_change', 'audit_routing_control_change'))
       AND NOT has_function_privilege('anon', 'public.enforce_routing_control_change()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_routing_control_change()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.audit_routing_control_change()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.audit_routing_control_change()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'the audit row carries before / after and the level, for a change and for an insert carrying a table',
       (SELECT prosrc LIKE '%''ROUTING_CONTROL_CHANGED''%'
           AND prosrc LIKE '%''before'', v_before, ''after'', NEW.routing_control%'
           AND prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%'
          FROM pg_proc WHERE proname = 'audit_routing_control_change'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_241_before ORDER BY ord) b
UNION ALL
SELECT 'after: libraries / folders / documents declaring a routing table', NULL,
       ((SELECT COUNT(*) FROM libraries WHERE routing_control IS NOT NULL)
        + (SELECT COUNT(*) FROM collections WHERE routing_control IS NOT NULL)
        + (SELECT COUNT(*) FROM documents WHERE routing_control IS NOT NULL))::text;
