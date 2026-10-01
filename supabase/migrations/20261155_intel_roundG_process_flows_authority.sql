-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-09) — who may write the plant's process topology.
--
-- process_flows (20261017) holds the plant's directional flow edges: drawn by
-- hand on the graph, or read off a PFD by the AI reader (/api/flows/read, the
-- service role) and confirmed by a person. Its INSERT policy checked only
-- active membership and self-attribution, so any member — a Viewer included —
-- could write a CONFIRMED edge into the shared map, or post a row claiming
-- origin 'ai', a real PFD page as its source and a controller's name as the
-- decider (FLOW-2 / AREA-3 / IEDGE-7 / IRLS-11, one root). Its endpoints are
-- (kind, ref) text pairs with no foreign key (by design: the two kinds live
-- in different registries), so a deleted asset left its flows dangling and a
-- unit ref could name a code the Site Codebook never held (WIRE-10 / FLOW-6 /
-- AREA-10 / IRLS-7). A dismissal had no revision: a Rev-0 "no" blocked the
-- reader on every later revision (IEDGE-8).
--
-- What this file changes (decision: DEC-44 (I-09), the plan's defaults):
--   1. A person's flow lands PROPOSED unless they are in the controller tier
--      (is_org_controller — Admin / DocCtrl held anywhere in the role
--      collection). A controller's hand-drawn flow is confirmed on arrival,
--      exactly as before. Nobody but the reader (the service role) writes
--      origin 'ai', a source document, page, revision or evidence: a person's
--      insert carrying any of them is refused (42501). The policy says the
--      same (status 'proposed' or the controller tier; origin 'manual'; no
--      source document) after the guard has run.
--   2. Deciding is the controller tier's: a status change by anyone else is
--      refused (42501), and decided_by / decided_at / decided_by_name are the
--      DATABASE's — the deciding person's uid, now(), their member address —
--      never what a client sent. created_by / created_by_name / created_at
--      are stamped the same way on a person's insert. A member keeps edit and
--      delete over their OWN row only while it is still a proposal (they can
--      withdraw it); a decided row is the controller tier's. A person's
--      update never changes a flow's endpoints, origin, author or where it
--      was read (42501) — except that the source may be CLEARED: deleting a
--      cited knowledge document runs 20261017's ON DELETE SET NULL as an
--      UPDATE under the deleting person's session, and it must land.
--   3. Endpoints exist (every writer, the service role included — 23503): an
--      'asset' end names an asset of the same org, a 'unit' end a Site
--      Codebook unit (codebook_entries kind 'unit') of the same org, and a
--      flow never starts and ends at the same endpoint (23514). A source
--      document is a knowledge document of the same org. Checked on INSERT
--      and when an endpoint or the source changes — an existing dangling row
--      can still be decided or removed.
--   4. Deleting an asset removes its flows (AFTER DELETE ON assets, under
--      the deleting person's RLS — asset DELETE is the controller tier's since
--      20261128, and a controller may delete any flow). Rows that already
--      dangle are COUNTED below and kept: the unit panel shows such an end as
--      equipment that no longer exists, with a remove button (IRLS-7's
--      read-time validation); the graph counts the severed edge (I-13).
--   5. process_flows.source_version_id — the knowledge document's revision a
--      proposal was read from (IEDGE-8). A dismissal judged THAT reading: the
--      reader may re-propose a pair a person dismissed only when the same
--      document has since moved to another revision; a dismissal with no
--      recorded revision (a hand-drawn row, an upload, every row before this
--      file) sticks.
--   6. An index on the to-side endpoint, so 4.'s cleanup and the endpoint
--      lookups do not scan the org's flows (the UNIQUE index covers the
--      from-side).
--
-- Neither function is SECURITY DEFINER: the guard reads what the writer may
-- read (its own member row, the org's assets and codebook), and the cleanup
-- deletes under the deleting person's RLS. auth.uid() IS NULL is the service
-- role only — RLS admits no anon write on process_flows (every policy needs
-- a member or a controller). Both pin search_path.
--
-- NARROWS (members outside the controller tier lose confirming a flow —
-- insert as confirmed, self-acceptance — and editing or deleting a decided
-- row they drew); nobody gains. Requires 20261017 (the table) and 20260814
-- (is_org_controller). Pre-apply inventory (DEC-30) is a TEMP TABLE captured
-- before the transaction, aggregate counts only; nothing existing is
-- rewritten or deleted. Single paste: inventory → BEGIN/DDL/COMMIT → ONE
-- SELECT (check text, ok boolean, n text). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- The controller predicate is spelled out (another person's tier, so
-- is_org_controller, which reads auth.uid(), cannot answer it): role IN
-- ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl'] — is_org_controller's
-- own body (20260814), pinned by test.
CREATE TEMP TABLE IF NOT EXISTS _intel_g55_before AS
SELECT 'process flows (all statuses)' AS what, COUNT(*) AS n FROM process_flows
UNION ALL
SELECT 'confirmed flows', COUNT(*) FROM process_flows WHERE status = 'confirmed'
UNION ALL
SELECT 'proposed flows awaiting a decision', COUNT(*) FROM process_flows WHERE status = 'proposed'
UNION ALL
SELECT 'dismissed flows (a person said no — they stay, so the reader does not re-propose them)', COUNT(*) FROM process_flows WHERE status = 'dismissed'
UNION ALL
SELECT 'confirmed flows drawn by someone outside the controller tier and decided by no controller (kept as they are; from now on such a flow lands proposed)', COUNT(*)
  FROM process_flows f
 WHERE f.status = 'confirmed'
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = f.org_id AND m.uid = f.created_by AND m.status = 'active'
                     AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = f.org_id AND m.uid = f.decided_by AND m.status = 'active'
                     AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
UNION ALL
SELECT 'flows attributed to the AI reader (origin ai) whose creator is not in the controller tier (the reader writes only for a controller — such a row may have been posted by hand; kept)', COUNT(*)
  FROM process_flows f
 WHERE f.origin = 'ai'
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = f.org_id AND m.uid = f.created_by AND m.status = 'active'
                     AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
UNION ALL
SELECT 'flows naming equipment that no longer exists (kept; the unit panel shows the end as gone and offers to remove it)', COUNT(*)
  FROM process_flows f
 WHERE (f.from_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.org_id = f.org_id AND a.id::text = f.from_ref))
    OR (f.to_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.org_id = f.org_id AND a.id::text = f.to_ref))
UNION ALL
SELECT 'flows naming a unit the Site Codebook does not hold (e.g. an operational-unit code Connect wrote — AREA-10; kept)', COUNT(*)
  FROM process_flows f
 WHERE (f.from_kind = 'unit' AND NOT EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = f.org_id AND c.kind = 'unit' AND c.code = f.from_ref))
    OR (f.to_kind = 'unit' AND NOT EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = f.org_id AND c.kind = 'unit' AND c.code = f.to_ref))
UNION ALL
SELECT 'flows citing a knowledge document of another workspace (IRLS-11; kept)', COUNT(*)
  FROM process_flows f JOIN knowledge_documents k ON k.id = f.source_document_id
 WHERE k.org_id <> f.org_id
UNION ALL
SELECT 'flows that start and end at the same endpoint (kept)', COUNT(*)
  FROM process_flows WHERE from_kind = to_kind AND from_ref = to_ref
UNION ALL
SELECT 'pairs recorded in both directions (A feeds B and B feeds A — a recycle loop, or a misread arrow; informational)', COUNT(*)
  FROM process_flows f
 WHERE EXISTS (SELECT 1 FROM process_flows r WHERE r.org_id = f.org_id
                 AND r.from_kind = f.to_kind AND r.from_ref = f.to_ref AND r.to_kind = f.from_kind AND r.to_ref = f.from_ref)
   AND (f.from_kind, f.from_ref) < (f.to_kind, f.to_ref)
UNION ALL
SELECT 'active members outside the controller tier — who LOSE confirming a flow (insert as confirmed, self-acceptance) and editing or deleting a decided flow they drew', COUNT(*)
  FROM org_members m
 WHERE m.status = 'active'
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[])
UNION ALL
SELECT 'of them, members who drew a flow that is now confirmed (each keeps it; only a controller edits or removes it from now on)', COUNT(DISTINCT f.created_by)
  FROM process_flows f JOIN org_members m ON m.org_id = f.org_id AND m.uid = f.created_by AND m.status = 'active'
 WHERE f.status IN ('confirmed', 'dismissed')
   AND NOT (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]);

BEGIN;

-- ── 5. The revision a proposal was read from (IEDGE-8) ──────────────────────
ALTER TABLE process_flows ADD COLUMN IF NOT EXISTS source_version_id UUID;

-- ── 6. The to-side endpoint, indexed ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS process_flows_to_idx ON process_flows (org_id, to_kind, to_ref);

-- ── 1–3. The guard ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION process_flows_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_controller boolean;
  v_email      text;
  v_kind       text;
  v_ref        text;
  v_found      boolean;
BEGIN
  -- 3. Endpoints exist — every writer, the service role included.
  IF TG_OP = 'INSERT'
     OR NEW.from_kind IS DISTINCT FROM OLD.from_kind OR NEW.from_ref IS DISTINCT FROM OLD.from_ref
     OR NEW.to_kind IS DISTINCT FROM OLD.to_kind OR NEW.to_ref IS DISTINCT FROM OLD.to_ref THEN
    IF NEW.from_kind = NEW.to_kind AND NEW.from_ref = NEW.to_ref THEN
      RAISE EXCEPTION 'process_flows_endpoint: a flow cannot start and end at the same %', NEW.from_kind
        USING ERRCODE = '23514';
    END IF;
    FOR v_kind, v_ref IN VALUES (NEW.from_kind, NEW.from_ref), (NEW.to_kind, NEW.to_ref) LOOP
      IF v_kind = 'asset' THEN
        v_found := false;
        IF v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_found := EXISTS (SELECT 1 FROM assets a WHERE a.id = v_ref::uuid AND a.org_id = NEW.org_id);
        END IF;
        IF NOT v_found THEN
          RAISE EXCEPTION 'process_flows_endpoint: equipment % is not in this workspace''s registry — a flow ends at registry equipment or a Site Codebook unit', v_ref
            USING ERRCODE = '23503';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = NEW.org_id AND c.kind = 'unit' AND c.code = v_ref) THEN
          RAISE EXCEPTION 'process_flows_endpoint: unit % is not a Site Codebook unit — a flow ends at registry equipment or a Site Codebook unit', v_ref
            USING ERRCODE = '23503';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NEW.source_document_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)
     AND NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = NEW.source_document_id AND k.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'process_flows_source: the source document is not a knowledge document of this workspace'
      USING ERRCODE = '23503';
  END IF;

  -- The reader (the service role) and the org restore are not a person.
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_email := (SELECT m.email FROM org_members m
               WHERE m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = 'active' LIMIT 1);

  IF TG_OP = 'INSERT' THEN
    -- 1. Provenance is the reader's.
    IF NEW.origin IS DISTINCT FROM 'manual' THEN
      RAISE EXCEPTION 'process_flows_origin: a flow read by the AI is written by the reader, never by a person'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.source_document_id IS NOT NULL OR NEW.source_page IS NOT NULL
       OR NEW.source_version_id IS NOT NULL OR NEW.evidence IS NOT NULL THEN
      RAISE EXCEPTION 'process_flows_provenance: where a flow was read is recorded by the reader, never by a person'
        USING ERRCODE = '42501';
    END IF;
    -- 1. A member's flow is a proposal; the controller tier's is confirmed.
    v_controller := is_org_controller(NEW.org_id);
    IF NOT v_controller THEN NEW.status := 'proposed'; END IF;
    -- 2. Stamped by the database.
    NEW.created_by := v_uid;
    NEW.created_by_name := v_email;
    NEW.created_at := now();
    IF NEW.status = 'proposed' THEN
      NEW.decided_by := NULL; NEW.decided_by_name := NULL; NEW.decided_at := NULL;
    ELSE
      NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE by a person. What a flow is, and where it was read, are fixed.
  -- One exception: the source may be CLEARED. Deleting the knowledge
  -- document a flow was read from runs the foreign key's ON DELETE SET NULL
  -- (20261017) as an UPDATE under the deleting person's session — refusing
  -- it would make every cited knowledge document, controlled document
  -- (20261122's cascade) and library undeletable. Setting or retargeting a
  -- source is still refused.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.from_kind IS DISTINCT FROM OLD.from_kind OR NEW.from_ref IS DISTINCT FROM OLD.from_ref
     OR NEW.to_kind IS DISTINCT FROM OLD.to_kind OR NEW.to_ref IS DISTINCT FROM OLD.to_ref
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)
     OR NEW.source_page IS DISTINCT FROM OLD.source_page
     OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'process_flows_fixed: a flow''s endpoints, origin, source and author are fixed — remove it and draw it again'
      USING ERRCODE = '42501';
  END IF;
  -- 2. Deciding is the controller tier's, stamped by the database.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT is_org_controller(NEW.org_id) THEN
      RAISE EXCEPTION 'process_flows_decide: only a document controller confirms, dismisses or reopens a flow'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'proposed' THEN
      NEW.decided_by := NULL; NEW.decided_by_name := NULL; NEW.decided_at := NULL;
    ELSE
      NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();
    END IF;
  ELSE
    NEW.decided_by := OLD.decided_by; NEW.decided_by_name := OLD.decided_by_name; NEW.decided_at := OLD.decided_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_process_flows_guard ON process_flows;
CREATE TRIGGER trg_process_flows_guard
  BEFORE INSERT OR UPDATE ON process_flows
  FOR EACH ROW EXECUTE FUNCTION process_flows_guard();

-- ── 1–2. The policies, from 20261017's text plus the authority clauses ──────
DROP POLICY IF EXISTS process_flows_insert ON process_flows;
CREATE POLICY process_flows_insert ON process_flows FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = process_flows.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND created_by = auth.uid()
  AND (status = 'proposed' OR is_org_controller(org_id))
  AND origin = 'manual'
  AND source_document_id IS NULL
);

DROP POLICY IF EXISTS process_flows_update ON process_flows;
CREATE POLICY process_flows_update ON process_flows FOR UPDATE USING (
  is_org_controller(org_id) OR (created_by = auth.uid() AND status = 'proposed')
) WITH CHECK (is_org_controller(org_id) OR (created_by = auth.uid() AND status = 'proposed'));

DROP POLICY IF EXISTS process_flows_delete ON process_flows;
CREATE POLICY process_flows_delete ON process_flows FOR DELETE USING (
  is_org_controller(org_id) OR (created_by = auth.uid() AND status = 'proposed')
);

-- ── 4. Deleting an asset removes its flows ─────────────────────────────────
CREATE OR REPLACE FUNCTION assets_process_flows_cleanup()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM process_flows
   WHERE org_id = OLD.org_id
     AND ((from_kind = 'asset' AND from_ref = OLD.id::text)
          OR (to_kind = 'asset' AND to_ref = OLD.id::text));
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_assets_process_flows_cleanup ON assets;
CREATE TRIGGER trg_assets_process_flows_cleanup
  AFTER DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_process_flows_cleanup();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'process_flows_insert: a person''s flow is proposed unless the controller tier, origin manual, no source document' AS "check",
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'process_flows' AND policyname = 'process_flows_insert' AND cmd = 'INSERT'
                  AND with_check LIKE '%is_org_controller(org_id)%'
                  AND with_check LIKE '%''proposed''%'
                  AND with_check LIKE '%''manual''%'
                  AND with_check LIKE '%source_document_id IS NULL%'
                  AND with_check LIKE '%created_by = auth.uid()%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'process_flows_update / _delete: the controller tier, or the author while the row is still a proposal',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename = 'process_flows' AND policyname IN ('process_flows_update', 'process_flows_delete')
           AND qual LIKE '%is_org_controller(org_id)%'
           AND qual LIKE '%created_by = auth.uid()%'
           AND qual LIKE '%''proposed''%')
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'process_flows' AND policyname = 'process_flows_update'
                      AND with_check LIKE '%is_org_controller(org_id)%' AND with_check LIKE '%''proposed''%'),
       NULL
UNION ALL
SELECT 'process_flows_select unchanged (every active member reads the map)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'process_flows' AND policyname = 'process_flows_select' AND cmd = 'SELECT'
                  AND qual LIKE '%auth.uid()%'),
       NULL
UNION ALL
SELECT 'the guard: BEFORE INSERT OR UPDATE, not SECURITY DEFINER, search_path pinned — status by authority, provenance the reader''s, decisions stamped, endpoints exist',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_process_flows_guard'
                AND tgrelid = 'process_flows'::regclass AND NOT tgisinternal
                AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)
       AND (SELECT prosrc LIKE '%IF NOT v_controller THEN NEW.status := ''proposed''; END IF;%'
                   AND prosrc LIKE '%process_flows_origin%'
                   AND prosrc LIKE '%process_flows_provenance%'
                   AND prosrc LIKE '%process_flows_decide%'
                   AND prosrc LIKE '%NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();%'
                   AND prosrc LIKE '%c.kind = ''unit'' AND c.code = v_ref%'
                   AND prosrc LIKE '%a.id = v_ref::uuid AND a.org_id = NEW.org_id%'
                   AND prosrc LIKE '%IF v_uid IS NULL THEN RETURN NEW; END IF;%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'process_flows_guard'),
       NULL
UNION ALL
SELECT 'deleting an asset removes its flows: AFTER DELETE ON assets, not SECURITY DEFINER, search_path pinned',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assets_process_flows_cleanup'
                AND tgrelid = 'assets'::regclass AND NOT tgisinternal
                AND (tgtype & 2) = 0 AND (tgtype & 8) <> 0)
       AND (SELECT prosrc LIKE '%DELETE FROM process_flows%'
                   AND prosrc LIKE '%from_ref = OLD.id::text%'
                   AND prosrc LIKE '%to_ref = OLD.id::text%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'assets_process_flows_cleanup'),
       NULL
UNION ALL
SELECT 'process_flows.source_version_id exists (the revision a proposal was read from — IEDGE-8)',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'process_flows' AND column_name = 'source_version_id'),
       NULL
UNION ALL
SELECT 'process_flows_to_idx exists (the to-side endpoint)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'process_flows' AND indexname = 'process_flows_to_idx'),
       NULL
UNION ALL
SELECT 'the guard lets a cited knowledge document be deleted: the foreign key''s ON DELETE SET NULL clears the source (setting or retargeting one is still refused)',
       (SELECT prosrc LIKE '%OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)%'
          FROM pg_proc WHERE proname = 'process_flows_guard')
       AND EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'process_flows'::regclass AND c.contype = 'f'
                      AND c.confrelid = 'knowledge_documents'::regclass AND c.confdeltype = 'n'),
       NULL
UNION ALL
SELECT 'is_org_controller still reads the role collection (20260814; the tier the guard and policies name)',
       (SELECT prosrc LIKE '%roles && ARRAY[''Admin'', ''DocCtrl'']::text[]%' FROM pg_proc WHERE proname = 'is_org_controller' LIMIT 1),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g55_before
UNION ALL
SELECT 'inventory (after): proposed flows awaiting a decision', NULL,
       (SELECT COUNT(*) FROM process_flows WHERE status = 'proposed')::text
UNION ALL
SELECT 'inventory (after): flows naming equipment that no longer exists (kept — shown as gone, removable by a controller)', NULL,
       (SELECT COUNT(*) FROM process_flows f
         WHERE (f.from_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.org_id = f.org_id AND a.id::text = f.from_ref))
            OR (f.to_kind = 'asset' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.org_id = f.org_id AND a.id::text = f.to_ref)))::text;
