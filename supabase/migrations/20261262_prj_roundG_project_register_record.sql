-- 20261262_prj_roundG_project_register_record.sql
--
-- projects-joint Round G, package J21 DRAFTING-REQUEST PROJECT REMAINDERS
-- (2026-10-22). DEC-30 one paste: a counts-only inventory BEFORE the
-- transaction (never a customer row), BEGIN … COMMIT, then ONE final result
-- set (check, ok, n) — the only one the Supabase SQL editor shows.
--
-- (1) drafting-flow PROJ-3 done-when 2 — every attach to and detach from a
--     project's document register (project_documents) writes an audit_logs
--     row SERVER-SIDE, whichever door made it: the Documents card, the
--     checkout resync (checkouts_resync_project_documents), the intake door
--     (intake_door_housekeep 'reference' or its service-role fallback),
--     adoption, DF-P8's routes, a restore, or a direct API call that writes
--     no feed row. NEW AFTER INSERT OR DELETE trigger
--     trg_project_documents_record_link on project_documents →
--     project_documents_record_link_change() (SECURITY DEFINER, search_path
--     pinned, EXECUTE revoked from every client role — DRLS-16):
--       * PROJECT_DOCUMENT_ATTACHED / PROJECT_DOCUMENT_DETACHED, resource_type
--         'project', resource_id the project (so a private project's rows are
--         read only by those who can read the project once 20261142 is in —
--         audit_row_project_visible), details { projectId, documentId,
--         documentNumber, linkId, source, recordedBy: 'database' };
--       * the actor: the signed-in caller when they are an active member of
--         the row's workspace (20261201's stamp then names them and their
--         role; the trigger reads no role itself — DB-7), else
--         user_id NULL (the service role: system) with a non-member caller's
--         uid kept as details.actorUid (the intake door's link identity);
--       * written in the attach / detach's OWN transaction — checked: an
--         attach or detach cannot land without its row. Every attach and
--         detach that lands today still lands (the row is written as the
--         table owner, every NOT NULL satisfied; PostgreSQL 16 cases below);
--       * a re-attach that changes nothing (ON CONFLICT DO NOTHING / DO
--         UPDATE) fires no AFTER INSERT, so it writes nothing;
--       * a cascade from the project's, the document's or the workspace's
--         own deletion is that deletion's record, not a detach: nothing is
--         written (and the deletion never fails on it).
--     lib/timeline.ts classifies the two actions "mirrored" (the card's
--     doc_added / doc_removed feed row already shows the fact on the
--     project timeline).
--
-- (2) drafting-flow PROJ-5 (done-whens 1 and 3) — project_documents.source
--     gains 'intake' (the CHECK widened; 'checkout' and 'manual' kept;
--     existing rows are NOT rewritten — the inventory counts the rows a
--     rewrite would have touched). NEW BEFORE INSERT OR UPDATE OF source
--     trigger trg_project_documents_intake_source →
--     project_documents_intake_source() (SECURITY DEFINER, pinned, revoked):
--       * a 'manual' reference written by THE INTAKE DOOR — the writer is
--         not an active member of the row's workspace (the door's link
--         identity, or the service role of its fallback) — to a document the
--         door CREATED (documents.authored_by_link_id set: the stored
--         intake-born fact, 20261104, which no signed-in session can stamp
--         once 20261141 is in) that sits in THE PROJECT'S OWN intake folder
--         (projects.intake_collection_id = documents.collection_id) is
--         written 'intake' — the door's reference at the moment it creates
--         the document, whichever of its paths wrote it. A member attaching
--         by hand — even a sheet filed by hand into the intake folder, or one
--         the door created — writes 'manual', exactly as today (J21 fix
--         pass: the badge and the audit row never say the intake link did
--         what a member did);
--       * an 'intake' row keeps 'intake' when a later write would call it
--         'manual' (the adoption's upsert, a re-attach from the card): the
--         origin stays. A 'checkout' value is never changed.
--     The app reads it (lib/projects.ts listProjectDocuments; the Documents
--     card's "from intake" badge). The project timeline's entry for an
--     adopted intake document is its TRANSITION_IN row (lib/timeline.ts
--     summary), on the timeline through the register reference.
--
-- (3) drafting-flow PROJ-10 done-when 2 — milestones.linked_ticket_id:
--     DROP-AS-UNUSED by record (no screen shows it; a request reaches its
--     project through tickets.project_id, one reference — GAP-114's "do not
--     add the reverse link as a second source of truth"). No destructive
--     DDL: the column, its key (ON DELETE SET NULL, 20260614) and its
--     mappings stay; a COMMENT says it is unused.
--
-- Not a widening of who may read or write anything: the register's policies
-- (20261102) are untouched; the CHECK admits one more value that only the
-- trigger writes.
--
-- Paste / deploy order: deploy the app carrying J21 first, then paste (an
-- app before J21 reads a source 'intake' row as "via checkout"). Either
-- order is safe for every flow: before the paste nothing is recorded or
-- rewritten (today's path); the app never writes 'intake' itself. It needs
-- 20260609 project_documents, 20260614 milestones, 20260902
-- projects.intake_collection_id and 20261104 documents.authored_by_link_id
-- (J21 fix pass) — it REFUSES TO RUN, changing nothing, without that column;
-- independent of every other migration. Re-runnable.
--
-- Reversal: DROP TRIGGER trg_project_documents_record_link ON
-- project_documents; DROP TRIGGER trg_project_documents_intake_source ON
-- project_documents; DROP FUNCTION project_documents_record_link_change();
-- DROP FUNCTION project_documents_intake_source(); then (only once no row
-- reads 'intake') UPDATE project_documents SET source = 'manual' WHERE
-- source = 'intake'; and re-add CHECK (source IN ('checkout','manual')).

-- ── Prerequisite (refuse to run, changing nothing, without 20261104) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'authored_by_link_id') THEN
    RAISE EXCEPTION 'Apply 20261104_prj_roundG_intake_links.sql first — this migration reads documents.authored_by_link_id (which document the intake door created). Nothing was changed.';
  END IF;
END;
$$;

DROP TABLE IF EXISTS prj_round_g_262_before;
CREATE TEMP TABLE prj_round_g_262_before AS
SELECT 1 AS ord, 'inventory (before apply): project_documents rows (all)' AS inventory, COUNT(*)::text AS n
  FROM project_documents
UNION ALL
SELECT 2, 'inventory (before apply): project_documents rows with source ''checkout''', COUNT(*)::text
  FROM project_documents WHERE source = 'checkout'
UNION ALL
SELECT 3, 'inventory (before apply): project_documents rows with source ''manual''', COUNT(*)::text
  FROM project_documents WHERE source = 'manual'
UNION ALL
SELECT 4, 'inventory (before apply): project_documents rows with any other source (0 before a first paste; on a re-paste, the ''intake'' rows)', COUNT(*)::text
  FROM project_documents WHERE source IS DISTINCT FROM 'checkout' AND source IS DISTINCT FROM 'manual'
UNION ALL
SELECT 5, 'inventory (before apply): ''manual'' rows whose document the intake door created (authored_by_link_id set) and still sits in its project''s intake folder — NOT rewritten (they stay ''manual'')', COUNT(*)::text
  FROM project_documents pd
  JOIN projects p ON p.id = pd.project_id
  JOIN documents d ON d.id = pd.document_id
 WHERE pd.source = 'manual' AND p.intake_collection_id IS NOT NULL AND d.collection_id = p.intake_collection_id
   AND d.authored_by_link_id IS NOT NULL
UNION ALL
SELECT 6, 'inventory (before apply): milestones whose linked_ticket_id is set (PROJ-10: no writer reaches it — expected 0; kept as is)', COUNT(*)::text
  FROM milestones WHERE linked_ticket_id IS NOT NULL;

BEGIN;

-- ── (2) the source CHECK, widened (re-runnable: every CHECK on source is
--        dropped by catalog, whatever its name, and the widened one added) ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conname
             FROM pg_constraint c
            WHERE c.conrelid = 'public.project_documents'::regclass AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) LIKE '%source%'
  LOOP
    EXECUTE format('ALTER TABLE project_documents DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE project_documents ADD CONSTRAINT project_documents_source_check
  CHECK (source IN ('checkout', 'manual', 'intake'));

CREATE OR REPLACE FUNCTION public.project_documents_intake_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The origin stays: a later 'manual' write keeps an intake reference 'intake'.
    IF OLD.source = 'intake' AND NEW.source = 'manual' THEN
      NEW.source := 'intake';
    END IF;
    RETURN NEW;
  END IF;
  -- A 'manual' reference is the intake door's only when the door writes it
  -- (no active member of the workspace behind it: the door's link identity,
  -- or the service role) for a document the door CREATED
  -- (authored_by_link_id) that sits in the project's own intake folder. A
  -- member's attach stays 'manual', whatever the document.
  IF NEW.source = 'manual'
     AND NOT EXISTS (
       SELECT 1
         FROM org_members m
        WHERE m.org_id = NEW.org_id AND m.uid = auth.uid() AND m.status = 'active')
     AND EXISTS (
       SELECT 1
         FROM projects p
         JOIN documents d ON d.id = NEW.document_id
        WHERE p.id = NEW.project_id
          AND p.intake_collection_id IS NOT NULL
          AND d.collection_id = p.intake_collection_id
          AND d.authored_by_link_id IS NOT NULL) THEN
    NEW.source := 'intake';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_documents_intake_source() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.project_documents_intake_source() IS
  'drafting-flow PROJ-5 (projects-joint J21, 20261262): a manual project_documents reference written by the intake door (no active member of the workspace behind it) to a document the door created (authored_by_link_id) in the project''s own intake folder is written source = ''intake''; a member''s attach stays ''manual''; an intake row keeps ''intake'' when a later write would call it ''manual''; ''checkout'' is never changed. Trigger only; SECURITY DEFINER (it reads projects / documents whatever the writer may see), search_path pinned, no client may EXECUTE it.';

DROP TRIGGER IF EXISTS trg_project_documents_intake_source ON project_documents;
CREATE TRIGGER trg_project_documents_intake_source
  BEFORE INSERT OR UPDATE OF source ON project_documents
  FOR EACH ROW EXECUTE FUNCTION public.project_documents_intake_source();

-- ── (1) the register's attach / detach record ───────────────────────────────
CREATE OR REPLACE FUNCTION public.project_documents_record_link_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    project_documents%ROWTYPE;
  v_uid    uuid := auth.uid();
  v_member boolean := false;
  v_email  text;
  v_number text;
  v_extra  jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_row := NEW;
  ELSE
    v_row := OLD;
  END IF;
  -- A cascade from the workspace's, the project's or the document's own
  -- deletion is that deletion's record, not a detach.
  IF NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = v_row.org_id)
     OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v_row.project_id)
     OR NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v_row.document_id) THEN
    RETURN NULL;
  END IF;
  IF v_uid IS NOT NULL THEN
    -- The member's email only: their role is stamped by 20261201's
    -- audit_logs_stamp_identity from their role collection (a headline read
    -- here would be the one DB-7 forbids).
    SELECT m.email INTO v_email
      FROM org_members m
     WHERE m.org_id = v_row.org_id AND m.uid = v_uid AND m.status = 'active'
     LIMIT 1;
    v_member := FOUND;
    IF NOT v_member THEN
      v_extra := jsonb_build_object('actorUid', v_uid);
    END IF;
  END IF;
  SELECT d.document_number INTO v_number FROM documents d WHERE d.id = v_row.document_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
    VALUES ('PROJECT_DOCUMENT_ATTACHED', 'project', v_row.project_id::text, v_row.org_id,
            CASE WHEN v_member THEN v_uid END, v_email, NULL,
            jsonb_build_object('projectId', v_row.project_id, 'documentId', v_row.document_id, 'documentNumber', v_number,
                               'linkId', v_row.id, 'source', v_row.source, 'recordedBy', 'database') || v_extra);
  ELSE
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
    VALUES ('PROJECT_DOCUMENT_DETACHED', 'project', v_row.project_id::text, v_row.org_id,
            CASE WHEN v_member THEN v_uid END, v_email, NULL,
            jsonb_build_object('projectId', v_row.project_id, 'documentId', v_row.document_id, 'documentNumber', v_number,
                               'linkId', v_row.id, 'source', v_row.source, 'recordedBy', 'database') || v_extra);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.project_documents_record_link_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.project_documents_record_link_change() IS
  'drafting-flow PROJ-3 done-when 2 (projects-joint J21, 20261262): every project_documents attach / detach writes one audit_logs row (PROJECT_DOCUMENT_ATTACHED / PROJECT_DOCUMENT_DETACHED, resource_type project) in its own transaction, whichever door made it; a cascade from the workspace''s, project''s or document''s own deletion writes nothing. The actor is the signed-in caller when an active member of the row''s workspace, else NULL (a non-member caller''s uid in details.actorUid). Trigger only; SECURITY DEFINER, search_path pinned, no client may EXECUTE it.';

DROP TRIGGER IF EXISTS trg_project_documents_record_link ON project_documents;
CREATE TRIGGER trg_project_documents_record_link
  AFTER INSERT OR DELETE ON project_documents
  FOR EACH ROW EXECUTE FUNCTION public.project_documents_record_link_change();

-- ── (3) PROJ-10 dw2: milestones.linked_ticket_id — unused, kept ─────────────
COMMENT ON COLUMN milestones.linked_ticket_id IS
  'UNUSED (drafting-flow PROJ-10, projects-joint J21, 20261262): no screen shows it and no writer sets it. A drafting request belongs to a project through tickets.project_id (20261256, GAP-114: one reference). Kept, not dropped (no destructive DDL); its key stays ON DELETE SET NULL.';

COMMIT;

SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'PROJ-5: project_documents.source admits checkout, manual and intake — exactly one CHECK on source' AS check,
       (SELECT COUNT(*) = 1 AND bool_and(pg_get_constraintdef(c.oid) LIKE '%checkout%' AND pg_get_constraintdef(c.oid) LIKE '%manual%' AND pg_get_constraintdef(c.oid) LIKE '%intake%')
          FROM pg_constraint c
         WHERE c.conrelid = 'public.project_documents'::regclass AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%source%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'PROJ-5: every project_documents row reads checkout, manual or intake (0 violations)',
       NOT EXISTS (SELECT 1 FROM project_documents WHERE source IS NULL OR source NOT IN ('checkout', 'manual', 'intake')),
       NULL
UNION ALL
SELECT 1, 3, 'PROJ-5: trg_project_documents_intake_source runs BEFORE INSERT OR UPDATE OF source (enabled; SECURITY DEFINER, search_path pinned; no client may EXECUTE it)',
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_project_documents_intake_source' AND t.tgrelid = 'public.project_documents'::regclass
                 AND NOT t.tgisinternal AND t.tgenabled = 'O'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF source ON public.project_documents FOR EACH ROW%')
       AND (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = 'public.project_documents_intake_source()'::regprocedure)
       AND NOT has_function_privilege('anon', 'public.project_documents_intake_source()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.project_documents_intake_source()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 4, 'PROJ-5: only the intake door''s manual reference to a document it created (authored_by_link_id) in the project''s own intake folder reads intake — a member''s attach stays manual; an intake row keeps intake against a later manual write',
       (SELECT prosrc LIKE '%OLD.source = ''intake'' AND NEW.source = ''manual''%NEW.source := ''intake''%FROM org_members m%m.uid = auth.uid()%d.collection_id = p.intake_collection_id%d.authored_by_link_id IS NOT NULL%NEW.source := ''intake''%'
          FROM pg_proc WHERE oid = 'public.project_documents_intake_source()'::regprocedure),
       NULL
UNION ALL
SELECT 2, 1, 'PROJ-3 dw2: trg_project_documents_record_link runs AFTER INSERT OR DELETE (enabled; SECURITY DEFINER, search_path pinned; no client may EXECUTE it)',
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_project_documents_record_link' AND t.tgrelid = 'public.project_documents'::regclass
                 AND NOT t.tgisinternal AND t.tgenabled = 'O'
                 AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT OR DELETE ON public.project_documents FOR EACH ROW%')
       AND (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = 'public.project_documents_record_link_change()'::regprocedure)
       AND NOT has_function_privilege('anon', 'public.project_documents_record_link_change()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.project_documents_record_link_change()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 2, 2, 'PROJ-3 dw2: the record writes PROJECT_DOCUMENT_ATTACHED and PROJECT_DOCUMENT_DETACHED as project rows, and nothing for a cascade from the workspace, project or document deletion',
       (SELECT prosrc LIKE '%NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = v_row.org_id)%NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v_row.project_id)%NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v_row.document_id)%''PROJECT_DOCUMENT_ATTACHED'', ''project''%''PROJECT_DOCUMENT_DETACHED'', ''project''%'
          FROM pg_proc WHERE oid = 'public.project_documents_record_link_change()'::regprocedure),
       NULL
UNION ALL
SELECT 3, 1, 'PROJ-10 dw2: milestones.linked_ticket_id is kept and marked unused (no destructive DDL)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'milestones' AND column_name = 'linked_ticket_id')
       AND COALESCE(col_description('public.milestones'::regclass,
             (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.milestones'::regclass AND a.attname = 'linked_ticket_id')), '') LIKE 'UNUSED (drafting-flow PROJ-10%',
       NULL
UNION ALL
SELECT 4, ord, inventory, NULL, n FROM prj_round_g_262_before
UNION ALL
SELECT 5, 1, 'inventory (after apply): project_documents rows with source ''intake'' (0 on a first paste — nothing is rewritten)', NULL,
       (SELECT COUNT(*)::text FROM project_documents WHERE source = 'intake')
) r
ORDER BY sec, ord;
