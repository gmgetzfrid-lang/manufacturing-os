-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — quality rails (J2 QUALITY: PC QUAL-12 / QUAL-11 /
-- QUAL-13 / QUAL-7 / QUAL-2; PT SAF-1..4 rails). One script, one result set.
--
-- 1. QUAL-12 — checklist_items.org_id was caller-supplied and the write
--    policy's WITH CHECK never compared it to the parent checklist, so a
--    project owner could stamp quality rows with another workspace's org id
--    (cross-tenant pollution, pulled into that org's backup). A BEFORE
--    INSERT OR UPDATE trigger now refuses any row whose org_id differs from
--    its checklist's, and checklist_items_write's WITH CHECK carries the
--    same predicate — the USING half and the two authority disjuncts are
--    byte-carried from 20261013 (lib/__tests__/qualityRailsMigration.test.ts
--    proves the diff is the one added predicate). NARROWS: strictly fewer
--    rows pass.
--    The HEADER had the same hole one row up: project_checklists_write
--    authorizes on user_owns_project(project_id) and never compares org_id
--    to the project's org, so an owner could insert a checklist stamped with
--    another workspace's org id and the items would follow it by design.
--    quality_row_org_matches_project() (BEFORE INSERT OR UPDATE) ties org_id
--    to projects.org_id on project_checklists and on every other
--    project-scoped quality table with that policy shape — turnover_items,
--    punch_items, and turnover_review_events (created below) — and
--    project_checklists_write's WITH CHECK carries the same predicate, the
--    rest byte-carried from 20261013 (lineDiff-pinned). NARROWS.
-- 2. QUAL-11 — turnover_review_events: an append-only review history
--    (reviewer, date, note, from → to, the reviewed document). A rejection is
--    recorded as kind = 'nonconformance' so the scorecard and the report can
--    read it; a reopen of an accepted / waived item is kind = 'reopen' and
--    the prior acceptance survives as a row instead of being overwritten.
--    INSERT is own-row only (reviewer = auth.uid()) under the same authority
--    as turnover_items_write, tied to a real item of the same org/project; no
--    UPDATE or DELETE policy exists for authenticated, and the verbs are
--    revoked outright.
-- 3. QUAL-7 — punch_items gains closed_by_name, description, location and
--    closure_note (all nullable text), so a closure names its closer and
--    what closed it, and done is distinguishable from void on the row.
-- 4. QUAL-2 — project_checklists.completed_basis ('human' | 'auto'): what a
--    completion rested on. Only a 'human' completion is citable as evidence
--    by another checklist (lib/checklists.ts gatherProjectEvidenceState).
--    Backfill = the rule completionBasis() (lib/checklistEngine.ts) applies
--    at completion: a completed checklist with ANY green (satisfied,
--    applicable) item that carries neither a human note nor a
--    person-attached chip → 'auto'; otherwise → 'human'. N/A items do not
--    bear on the basis — every path to N/A is a person's (the item's own
--    control with a reason, or a proposal ticked one by one in the
--    assessment review) and an N/A proves nothing.
-- 5. The CHECK constraints REL-4's quality half asks for already exist in
--    20261013 (project_checklists.status, checklist_items.status /
--    applicability, turnover_items.status, punch_items.status) — probed, not
--    re-created.
--
-- DEC-30 inventory (captured BEFORE the transaction, aggregate counts only):
--   * checklist_items whose org_id <> the parent's, and project_checklists /
--     turnover_items / punch_items whose org_id <> their project's —
--     surfaced for a human: either corruption or an attack; the triggers
--     will refuse UPDATEs to such rows until org_id is corrected.
--   * satisfied items whose every evidence chip is source = 'auto' — the
--     QUAL-1 stale-green candidates. NOT auto-downgraded here: the next
--     evidence sweep retracts them visibly, one audit row per item.
--   * completed checklists with a green resting on the sweep alone —
--     backfilled to completed_basis = 'auto' below.
-- The inventory's label column is `label`, never a reserved word: the final
-- SELECT references it bare (a bare `check` column ref is a syntax error).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DEC-30 inventory — BEFORE the transaction; counts only, never rows ───────
DROP TABLE IF EXISTS prj_roundg_quality_inventory;
CREATE TEMP TABLE prj_roundg_quality_inventory AS
SELECT 'inventory: checklist_items whose org_id differs from the parent checklist (QUAL-12 — corruption or attack; needs a human before those rows can be updated)'::text AS label,
       (SELECT COUNT(*) FROM checklist_items i
          JOIN project_checklists c ON c.id = i.checklist_id
         WHERE i.org_id <> c.org_id)::text AS n
UNION ALL
SELECT 'inventory: project_checklists whose org_id differs from the project (QUAL-12 header — needs a human before those rows can be updated)',
       (SELECT COUNT(*) FROM project_checklists c
          JOIN projects p ON p.id = c.project_id
         WHERE c.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: turnover_items whose org_id differs from the project (QUAL-12 sibling — needs a human before those rows can be updated)',
       (SELECT COUNT(*) FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: punch_items whose org_id differs from the project (QUAL-12 sibling — needs a human before those rows can be updated)',
       (SELECT COUNT(*) FROM punch_items k
          JOIN projects p ON p.id = k.project_id
         WHERE k.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: satisfied items whose evidence is auto-only (QUAL-1 stale-green candidates — listed for review; the next sweep retracts visibly, never this script)',
       (SELECT COUNT(*) FROM checklist_items i
         WHERE i.status = 'satisfied'
           AND i.manual_note IS NULL
           AND jsonb_typeof(i.evidence) = 'array'
           AND jsonb_array_length(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) > 0
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                            WHERE e->>'source' = 'manual'))::text
UNION ALL
SELECT 'inventory: completed checklists with a green item resting on the sweep alone (QUAL-2 — completed_basis backfills to auto; not citable until verified and re-completed)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.status = 'satisfied' AND i.applicability <> 'na'
                AND i.manual_note IS NULL
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                                 WHERE e->>'source' = 'manual')))::text
UNION ALL
SELECT 'inventory: completed checklists (all)',
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete')::text
UNION ALL
SELECT 'inventory: turnover_items accepted or waived (reopenable after apply; their history starts at the next decision)',
       (SELECT COUNT(*) FROM turnover_items WHERE status IN ('accepted', 'waived'))::text
UNION ALL
SELECT 'inventory: punch_items already closed (done/void) — closed_by_name stays NULL on these; the closer is in audit_logs PUNCH_STATUS',
       (SELECT COUNT(*) FROM punch_items WHERE status IN ('done', 'void'))::text;

BEGIN;

-- ── 1. QUAL-12: checklist_items.org_id is the parent checklist's org ─────────
CREATE OR REPLACE FUNCTION checklist_items_org_matches_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT c.org_id INTO v_org FROM project_checklists c WHERE c.id = NEW.checklist_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'checklist_items: parent checklist % not found', NEW.checklist_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'checklist_items: org_id must equal the parent checklist org_id (QUAL-12)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION checklist_items_org_matches_parent() IS
  'QUAL-12: a checklist item row always carries its parent checklist org_id — refuses a caller-supplied foreign org on INSERT and UPDATE.';

DROP TRIGGER IF EXISTS trg_checklist_items_org_matches_parent ON checklist_items;
CREATE TRIGGER trg_checklist_items_org_matches_parent
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION checklist_items_org_matches_parent();

-- The write policy: USING and the two authority disjuncts byte-carried from
-- 20261013; WITH CHECK additionally ties org_id to the parent checklist.
DROP POLICY IF EXISTS checklist_items_write ON checklist_items;
CREATE POLICY checklist_items_write ON checklist_items FOR ALL
  USING (is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))
  WITH CHECK ((is_org_controller(org_id) OR EXISTS (
    SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))
    AND org_id = (SELECT c.org_id FROM project_checklists c WHERE c.id = checklist_items.checklist_id));

COMMENT ON POLICY checklist_items_write ON checklist_items IS
  'Controllers or the project owner write; WITH CHECK also requires org_id = the parent checklist org_id (QUAL-12).';

-- ── 1b. QUAL-12 header + siblings: org_id is the PROJECT's org ─────────────
-- project_checklists / turnover_items / punch_items authorize on
-- user_owns_project(project_id), which never looks at org_id — so the header
-- (and each sibling) could carry a foreign org, and checklist_items would
-- follow the header. One trigger function, generic over (org_id, project_id).
CREATE OR REPLACE FUNCTION quality_row_org_matches_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT p.org_id INTO v_org FROM projects p WHERE p.id = NEW.project_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION '%: project % not found', TG_TABLE_NAME, NEW.project_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.org_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION '%: org_id must equal the project org_id (QUAL-12)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION quality_row_org_matches_project() IS
  'QUAL-12: a project-scoped quality row (checklist header, turnover item, punch item, turnover review event) always carries its project org_id — refuses a caller-supplied foreign org on INSERT and UPDATE.';

DROP TRIGGER IF EXISTS trg_project_checklists_org_matches_project ON project_checklists;
CREATE TRIGGER trg_project_checklists_org_matches_project
  BEFORE INSERT OR UPDATE ON project_checklists
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project();

DROP TRIGGER IF EXISTS trg_turnover_items_org_matches_project ON turnover_items;
CREATE TRIGGER trg_turnover_items_org_matches_project
  BEFORE INSERT OR UPDATE ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project();

DROP TRIGGER IF EXISTS trg_punch_items_org_matches_project ON punch_items;
CREATE TRIGGER trg_punch_items_org_matches_project
  BEFORE INSERT OR UPDATE ON punch_items
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project();

-- The header's write policy: USING and the two authority disjuncts
-- byte-carried from 20261013; WITH CHECK additionally ties org_id to the
-- project's org.
DROP POLICY IF EXISTS project_checklists_write ON project_checklists;
CREATE POLICY project_checklists_write ON project_checklists FOR ALL
  USING (is_org_controller(org_id) OR user_owns_project(project_id))
  WITH CHECK ((is_org_controller(org_id) OR user_owns_project(project_id))
    AND org_id = (SELECT p.org_id FROM projects p WHERE p.id = project_checklists.project_id));

COMMENT ON POLICY project_checklists_write ON project_checklists IS
  'Controllers or the project owner write; WITH CHECK also requires org_id = the project org_id (QUAL-12).';

-- ── 2. QUAL-11: the turnover review history, append-only ─────────────────────
CREATE TABLE IF NOT EXISTS turnover_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES turnover_items(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open','received','accepted','rejected','waived')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open','received','accepted','rejected','waived')),
  kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review','reopen','nonconformance')),
  reviewer UUID NOT NULL,
  reviewer_name TEXT,
  note TEXT,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS turnover_review_events_item_idx ON turnover_review_events (item_id, created_at);
CREATE INDEX IF NOT EXISTS turnover_review_events_project_idx ON turnover_review_events (project_id, kind);
COMMENT ON TABLE turnover_review_events IS
  'QUAL-11: append-only review history for turnover items — every decision, a rejection as a nonconformance, a reopen with its reason. Never updated or deleted by the application.';

ALTER TABLE turnover_review_events ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON turnover_review_events FROM authenticated, anon;

DROP POLICY IF EXISTS turnover_review_events_member_read ON turnover_review_events;
CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = turnover_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));

DROP POLICY IF EXISTS turnover_review_events_insert_own ON turnover_review_events;
CREATE POLICY turnover_review_events_insert_own ON turnover_review_events FOR INSERT
  WITH CHECK (
    reviewer = auth.uid()
    AND (is_org_controller(org_id) OR user_owns_project(project_id))
    AND EXISTS (
      SELECT 1 FROM turnover_items t
      WHERE t.id = turnover_review_events.item_id
        AND t.org_id = turnover_review_events.org_id
        AND t.project_id = turnover_review_events.project_id
    )
  );

DROP TRIGGER IF EXISTS trg_turnover_review_events_org_matches_project ON turnover_review_events;
CREATE TRIGGER trg_turnover_review_events_org_matches_project
  BEFORE INSERT OR UPDATE ON turnover_review_events
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project();

-- ── 3. QUAL-7: the punch record ──────────────────────────────────────────────
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closed_by_name TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closure_note TEXT;
COMMENT ON COLUMN punch_items.closure_note IS 'QUAL-7: what closed the item (done) or why it was voided (void — a reason is required by lib/turnover.ts).';

-- ── 4. QUAL-2: what a completion rested on ───────────────────────────────────
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT
  CHECK (completed_basis IS NULL OR completed_basis IN ('human','auto'));
COMMENT ON COLUMN project_checklists.completed_basis IS
  'QUAL-2: human = every satisfied / N/A item carries a human decision; auto = at least one rests on the sweep or the assessment alone. Only human is citable as evidence elsewhere.';

UPDATE project_checklists c
   SET completed_basis = 'auto'
 WHERE c.status = 'complete'
   AND c.completed_basis IS NULL
   AND EXISTS (
     SELECT 1 FROM checklist_items i
      WHERE i.checklist_id = c.id
        AND i.status = 'satisfied' AND i.applicability <> 'na'
        AND i.manual_note IS NULL
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                         WHERE e->>'source' = 'manual'));

UPDATE project_checklists c
   SET completed_basis = 'human'
 WHERE c.status = 'complete'
   AND c.completed_basis IS NULL;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_policies.qual / with_check are DEPARSED; pg_proc.prosrc is verbatim.
--    `check` appears only as an output label (AS check); the inventory's
--    column is `label` — a bare `check` column ref is a syntax error.
SELECT 'trigger trg_checklist_items_org_matches_parent is live on checklist_items (BEFORE INSERT OR UPDATE)' AS check,
       (SELECT COUNT(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'checklist_items' AND t.tgname = 'trg_checklist_items_org_matches_parent' AND NOT t.tgisinternal) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'checklist_items_org_matches_parent is SECURITY DEFINER with search_path pinned to public',
       (SELECT p.prosecdef AND COALESCE(array_to_string(p.proconfig, ',') LIKE '%search_path=public%', false)
          FROM pg_proc p WHERE p.proname = 'checklist_items_org_matches_parent'),
       NULL
UNION ALL
SELECT 'checklist_items_org_matches_parent refuses a foreign org (QUAL-12 body)',
       (SELECT p.prosrc LIKE '%NEW.org_id IS DISTINCT FROM v_org%' AND p.prosrc LIKE '%check_violation%'
          FROM pg_proc p WHERE p.proname = 'checklist_items_org_matches_parent'),
       NULL
UNION ALL
SELECT 'checklist_items_write is the ONLY permissive FOR ALL policy on checklist_items',
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'checklist_items' AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
           AND policyname = 'checklist_items_write'),
       NULL
UNION ALL
SELECT 'checklist_items_write WITH CHECK ties org_id to the parent checklist',
       (SELECT with_check LIKE '%org_id = ( SELECT c.org_id%'
           AND with_check LIKE '%c.id = checklist_items.checklist_id%'
          FROM pg_policies WHERE tablename = 'checklist_items' AND policyname = 'checklist_items_write'),
       NULL
UNION ALL
SELECT 'checklist_items_write USING keeps both authority disjuncts (controller OR project owner)',
       (SELECT qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(c.project_id)%'
          FROM pg_policies WHERE tablename = 'checklist_items' AND policyname = 'checklist_items_write'),
       NULL
UNION ALL
SELECT 'checklist_items_member_read (20261013) untouched',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'checklist_items' AND policyname = 'checklist_items_member_read' AND cmd = 'SELECT'),
       NULL
UNION ALL
SELECT 'quality_row_org_matches_project is SECURITY DEFINER with search_path pinned to public',
       (SELECT p.prosecdef AND COALESCE(array_to_string(p.proconfig, ',') LIKE '%search_path=public%', false)
          FROM pg_proc p WHERE p.proname = 'quality_row_org_matches_project'),
       NULL
UNION ALL
SELECT 'quality_row_org_matches_project refuses an org_id that is not the project org (QUAL-12 header body)',
       (SELECT p.prosrc LIKE '%FROM projects p WHERE p.id = NEW.project_id%'
           AND p.prosrc LIKE '%NEW.org_id IS DISTINCT FROM v_org%' AND p.prosrc LIKE '%check_violation%'
          FROM pg_proc p WHERE p.proname = 'quality_row_org_matches_project'),
       NULL
UNION ALL
SELECT 'the project-org trigger is live (BEFORE INSERT OR UPDATE) on project_checklists, turnover_items, punch_items, turnover_review_events',
       (SELECT COUNT(DISTINCT c.relname) = 4 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE f.proname = 'quality_row_org_matches_project' AND NOT t.tgisinternal
           AND c.relname IN ('project_checklists', 'turnover_items', 'punch_items', 'turnover_review_events')),
       NULL
UNION ALL
SELECT 'project_checklists_write is the ONLY permissive FOR ALL policy on project_checklists',
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'project_checklists' AND cmd = 'ALL' AND permissive = 'PERMISSIVE'
           AND policyname = 'project_checklists_write'),
       NULL
UNION ALL
SELECT 'project_checklists_write WITH CHECK ties org_id to the project org, and USING keeps both authority disjuncts',
       (SELECT with_check LIKE '%org_id = ( SELECT p.org_id%'
           AND with_check LIKE '%p.id = project_checklists.project_id%'
           AND qual LIKE '%is_org_controller(org_id)%' AND qual LIKE '%user_owns_project(project_id)%'
          FROM pg_policies WHERE tablename = 'project_checklists' AND policyname = 'project_checklists_write'),
       NULL
UNION ALL
SELECT 'turnover_review_events exists with RLS enabled',
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'turnover_review_events'),
       NULL
UNION ALL
SELECT 'turnover_review_events: exactly two policies — member SELECT and own-row INSERT, no UPDATE / DELETE / ALL policy',
       (SELECT COUNT(*) FILTER (WHERE cmd = 'SELECT' AND policyname = 'turnover_review_events_member_read') = 1
           AND COUNT(*) FILTER (WHERE cmd = 'INSERT' AND policyname = 'turnover_review_events_insert_own') = 1
           AND COUNT(*) FILTER (WHERE cmd IN ('UPDATE', 'DELETE', 'ALL')) = 0
          FROM pg_policies WHERE tablename = 'turnover_review_events'),
       NULL
UNION ALL
SELECT 'turnover_review_events INSERT is own-row (reviewer = auth.uid()) under turnover authority, tied to a real item of the same org/project',
       (SELECT with_check LIKE '%reviewer = auth.uid()%'
           AND with_check LIKE '%is_org_controller(org_id)%'
           AND with_check LIKE '%user_owns_project(project_id)%'
           AND with_check LIKE '%t.id = turnover_review_events.item_id%'
           AND with_check LIKE '%t.org_id = turnover_review_events.org_id%'
          FROM pg_policies WHERE tablename = 'turnover_review_events' AND policyname = 'turnover_review_events_insert_own'),
       NULL
UNION ALL
SELECT 'turnover_review_events: UPDATE and DELETE revoked from authenticated',
       (SELECT NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'UPDATE')
           AND NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'DELETE')),
       NULL
UNION ALL
SELECT 'turnover_review_events.kind is constrained to review / reopen / nonconformance',
       (SELECT COUNT(*) = 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE c.relname = 'turnover_review_events' AND k.contype = 'c'
           AND pg_get_constraintdef(k.oid) LIKE '%nonconformance%'),
       NULL
UNION ALL
SELECT 'punch_items carries closed_by_name, description, location, closure_note',
       (SELECT COUNT(*) = 4 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'punch_items'
           AND column_name IN ('closed_by_name', 'description', 'location', 'closure_note')),
       NULL
UNION ALL
SELECT 'project_checklists.completed_basis exists and is constrained to human / auto',
       (SELECT COUNT(*) = 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE c.relname = 'project_checklists' AND k.contype = 'c'
           AND pg_get_constraintdef(k.oid) LIKE '%completed_basis%'),
       NULL
UNION ALL
SELECT 'every completed checklist carries a completed_basis after the backfill',
       (SELECT COUNT(*) = 0 FROM project_checklists WHERE status = 'complete' AND completed_basis IS NULL),
       NULL
UNION ALL
SELECT 'REL-4 quality half: status / applicability CHECK constraints present on all four quality tables (20261013)',
       (SELECT COUNT(DISTINCT c.relname) = 4 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE k.contype = 'c'
           AND c.relname IN ('project_checklists', 'checklist_items', 'turnover_items', 'punch_items')
           AND pg_get_constraintdef(k.oid) LIKE '%status%'),
       NULL
UNION ALL
SELECT 'inventory (after backfill): completed checklists now at completed_basis = auto', NULL,
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete' AND completed_basis = 'auto')::text
UNION ALL
SELECT 'inventory (after backfill): completed checklists now at completed_basis = human', NULL,
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete' AND completed_basis = 'human')::text
UNION ALL
SELECT label, NULL, n FROM prj_roundg_quality_inventory;
