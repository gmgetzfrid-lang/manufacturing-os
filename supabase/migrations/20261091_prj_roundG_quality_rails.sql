-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — quality rails (J2 QUALITY: PC QUAL-12 / QUAL-11 /
-- QUAL-13 / QUAL-7 / QUAL-2; PT SAF-1..4 rails). One script, one result set.
--
-- The rules the quality data layer (lib/checklists.ts, lib/turnover.ts)
-- checks are ENFORCED here, so a write that bypasses the lib — a direct
-- PostgREST call with the user's own token — meets the same rules
-- (GAP-405: "do not make it a client-side check").
--
-- 0. Columns and backfills FIRST, before this script creates any trigger.
--    A trigger created earlier in the same transaction fires on the
--    backfill's own UPDATE / INSERT: the project-org trigger (§2) would abort
--    the whole script on one legacy row whose org is mismatched, and the
--    completion-basis rail (§5) would keep a NULL basis.
--    0a. QUAL-2 — project_checklists.completed_basis ('human' | 'auto'): what
--        a completion rested on; only 'human' is citable as evidence by
--        another checklist (lib/checklists.ts gatherProjectEvidenceState).
--        checklist_completion_basis(id) is THE rule — the same one
--        completionBasis() applies in lib/checklistEngine.ts: 'auto' when a
--        green rests on the evidence sweep alone (no note, no person-attached
--        chip), when an N/A carries no person's reason (the assessment's, or
--        a legacy one), or when no green was decided by a person at all
--        (an all-N/A checklist proves nothing); otherwise 'human'. The
--        backfill calls it for every completed checklist.
--    0b. QUAL-7 — punch_items gains closed_by_name, description, location and
--        closure_note (nullable text): a closure names its closer and what
--        closed it, and done is distinguishable from void on the row.
--    0c. QUAL-11 — turnover_review_events: an append-only review history
--        (reviewer, date, note, from → to, the reviewed document); a
--        rejection is kind = 'nonconformance', a move out of accepted /
--        waived is kind = 'reopen'. Members read it; NO client writes it
--        (INSERT / UPDATE / DELETE / TRUNCATE revoked, no write policy): §3's
--        trigger writes it in the same statement as the decision. The
--        backfill writes one row per item already decided (accepted / waived
--        / rejected) with the reviewer, date and note the row carries, so a
--        decision made before this script survives a later reopen.
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
-- 2. QUAL-12, one row up — project_checklists_write authorizes on
--    user_owns_project(project_id) and never compares org_id to the project's
--    org. quality_row_org_matches_project() (BEFORE INSERT OR UPDATE) ties
--    org_id to projects.org_id on project_checklists, turnover_items,
--    punch_items and turnover_review_events, and project_checklists_write's
--    WITH CHECK carries the same predicate (the rest byte-carried from
--    20261013, lineDiff-pinned). NARROWS. The trigger's arguments name each
--    table's ON DELETE SET NULL reference columns: an UPDATE that only nulls
--    one of them (what deleting a document or a party does to the rows that
--    cite it) passes, so a legacy mismatched row never blocks that delete.
-- 3. QUAL-11 — turnover_items_record_review_event() (AFTER INSERT OR UPDATE
--    OF status): every status change of a turnover item appends its history
--    row, atomically with the change — the reviewer is auth.uid(); the name
--    and note are the row's when the write stamped a fresh reviewed_at.
-- 4. SAF-4 / GAP-405 — the reason bar at the database. quality_reason_ok()
--    mirrors reasonProblem() (lib/checklistEngine.ts): at least 10
--    non-whitespace characters, none of the canned strings. A turnover item
--    moving to waived / rejected, or out of accepted / waived (a reopen),
--    needs one in review_note; a punch item moving to void needs one in
--    closure_note; a checklist item a person (a uid-stamped write) moves to
--    N/A needs one in manual_note. The service pass (auth.uid() IS NULL —
--    restores, server routes, the SQL editor) passes, as in 20261056 /
--    20261062. NARROWS.
-- 5. QUAL-2 — project_checklists_completion_basis_rail(): for every
--    end-user write the DATABASE records completed_basis — computed by
--    checklist_completion_basis() when the status moves to complete, kept
--    when it stays complete, NULL otherwise; a client-supplied value is
--    ignored. NARROWS.
-- 6. The CHECK constraints REL-4's quality half asks for already exist in
--    20261013 (project_checklists.status, checklist_items.status /
--    applicability, turnover_items.status, punch_items.status) — probed, not
--    re-created.
--
-- DEC-30 inventory (captured BEFORE the transaction, aggregate counts only):
--   * checklist_items whose org_id <> the parent's, and project_checklists /
--     turnover_items / punch_items whose org_id <> their project's —
--     surfaced for a human: either corruption or an attack. Until a person
--     corrects org_id the triggers refuse any other change to such a row
--     (a status change of a mismatched turnover item included); an update
--     that only nulls a reference column — a document or party delete —
--     passes.
--   * satisfied items whose every evidence chip is source = 'auto' — the
--     QUAL-1 stale-green candidates. NOT auto-downgraded here: the next
--     evidence sweep re-checks them and withdraws any whose proof is gone
--     (one audit row per sweep, naming each item), and Mark complete
--     re-checks them too.
--   * completed checklists that backfill to 'auto', by reason.
--   * decided turnover items (their history is backfilled), those with no
--     reviewer uid on record, and those skipped because their org is
--     mismatched; waived / rejected items whose note is under the bar.
-- The inventory's label column is `label`, never a reserved word: the final
-- SELECT references it bare (a bare `check` column ref is a syntax error).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DEC-30 inventory — BEFORE the transaction; counts only, never rows ───────
DROP TABLE IF EXISTS prj_roundg_quality_inventory;
CREATE TEMP TABLE prj_roundg_quality_inventory AS
SELECT 'inventory: checklist_items whose org_id differs from the parent checklist (QUAL-12 — corruption or attack; needs a human before those rows can be changed)'::text AS label,
       (SELECT COUNT(*) FROM checklist_items i
          JOIN project_checklists c ON c.id = i.checklist_id
         WHERE i.org_id <> c.org_id)::text AS n
UNION ALL
SELECT 'inventory: project_checklists whose org_id differs from the project (QUAL-12 header — needs a human before those rows can be changed)',
       (SELECT COUNT(*) FROM project_checklists c
          JOIN projects p ON p.id = c.project_id
         WHERE c.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: turnover_items whose org_id differs from the project (QUAL-12 sibling — needs a human before those rows can be changed)',
       (SELECT COUNT(*) FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: punch_items whose org_id differs from the project (QUAL-12 sibling — needs a human before those rows can be changed)',
       (SELECT COUNT(*) FROM punch_items k
          JOIN projects p ON p.id = k.project_id
         WHERE k.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: satisfied items whose evidence is auto-only (QUAL-1 stale-green candidates — the next sweep and Mark complete re-check them; one audit row per sweep names each withdrawal; never this script)',
       (SELECT COUNT(*) FROM checklist_items i
         WHERE i.status = 'satisfied'
           AND i.manual_note IS NULL
           AND jsonb_typeof(i.evidence) = 'array'
           AND jsonb_array_length(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) > 0
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                            WHERE e->>'source' = 'manual'))::text
UNION ALL
SELECT 'inventory: completed checklists with a green item resting on the sweep alone (QUAL-2 — backfills to auto; not citable until verified and re-completed)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.status = 'satisfied' AND i.applicability <> 'na'
                AND COALESCE(i.manual_note, '') = ''
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                                 WHERE e->>'source' = 'manual')))::text
UNION ALL
SELECT 'inventory: completed checklists with an N/A no person gave a reason for (QUAL-2 — the assessment''s or a legacy N/A; backfills to auto)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND (i.status = 'na' OR i.applicability = 'na')
                AND COALESCE(i.manual_note, '') = ''))::text
UNION ALL
SELECT 'inventory: completed checklists with no green item a person decided (QUAL-2 — nothing on them was verified by anyone; backfills to auto)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND NOT EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.status = 'satisfied' AND i.applicability <> 'na'
                AND (COALESCE(i.manual_note, '') <> ''
                     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                                 WHERE e->>'source' = 'manual'))))::text
UNION ALL
SELECT 'inventory: completed checklists (all)',
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete')::text
UNION ALL
SELECT 'inventory: turnover_items with a decision (accepted / waived / rejected) — each whose org matches its project gets one backfilled history row (QUAL-11)',
       (SELECT COUNT(*) FROM turnover_items WHERE status IN ('accepted', 'waived', 'rejected'))::text
UNION ALL
SELECT 'inventory: decided turnover_items with no reviewer uid on record — backfilled with the name, date and note the row carries, reviewer unknown',
       (SELECT COUNT(*) FROM turnover_items WHERE status IN ('accepted', 'waived', 'rejected') AND reviewed_by IS NULL)::text
UNION ALL
SELECT 'inventory: decided turnover_items whose org differs from the project — history NOT backfilled; their status cannot change until a person corrects org_id',
       (SELECT COUNT(*) FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.status IN ('accepted', 'waived', 'rejected') AND t.org_id <> p.org_id)::text
UNION ALL
SELECT 'inventory: waived / rejected turnover_items whose note is under 10 non-whitespace characters (legacy — listed, never rewritten; the rail governs new decisions)',
       (SELECT COUNT(*) FROM turnover_items
         WHERE status IN ('waived', 'rejected')
           AND length(regexp_replace(COALESCE(review_note, ''), '\s', '', 'g')) < 10)::text
UNION ALL
SELECT 'inventory: punch_items already closed (done/void) — closed_by_name stays NULL on these; the closer is in audit_logs PUNCH_STATUS',
       (SELECT COUNT(*) FROM punch_items WHERE status IN ('done', 'void'))::text;

BEGIN;

-- ── 0a. QUAL-2: what a completion rested on — the rule, then the backfill ────
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT
  CHECK (completed_basis IS NULL OR completed_basis IN ('human','auto'));
COMMENT ON COLUMN project_checklists.completed_basis IS
  'QUAL-2: human = no green rests on the sweep alone, every N/A carries a person''s reason, and at least one green was decided by a person; auto = otherwise. Only human is citable as evidence elsewhere. Recorded by the database (checklist_completion_basis), never by the client.';

CREATE OR REPLACE FUNCTION checklist_completion_basis(p_checklist_id uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
    -- a green resting on the evidence sweep alone: no note, no person-attached chip
    WHEN EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND i.status = 'satisfied' AND i.applicability <> 'na'
         AND COALESCE(i.manual_note, '') = ''
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                          WHERE e->>'source' = 'manual'))
      THEN 'auto'
    -- an N/A no person gave a reason for (the assessment's, or a legacy one)
    WHEN EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND (i.status = 'na' OR i.applicability = 'na')
         AND COALESCE(i.manual_note, '') = '')
      THEN 'auto'
    -- no green a person decided: nothing on the checklist was verified by anyone
    WHEN NOT EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND i.status = 'satisfied' AND i.applicability <> 'na'
         AND (COALESCE(i.manual_note, '') <> ''
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                          WHERE e->>'source' = 'manual')))
      THEN 'auto'
    ELSE 'human'
  END;
$$;

COMMENT ON FUNCTION checklist_completion_basis(uuid) IS
  'QUAL-2: the completion basis of a checklist, by the rule completionBasis() applies in lib/checklistEngine.ts. Called by the backfill below and by project_checklists_completion_basis_rail.';

-- On a re-run the project-org trigger already exists; it is re-created in §2,
-- so drop it here and the backfill meets the same state as a first run.
DROP TRIGGER IF EXISTS trg_project_checklists_org_matches_project ON project_checklists;

UPDATE project_checklists c
   SET completed_basis = checklist_completion_basis(c.id)
 WHERE c.status = 'complete'
   AND c.completed_basis IS NULL;

-- ── 0b. QUAL-7: the punch record ─────────────────────────────────────────────
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closed_by_name TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closure_note TEXT;
COMMENT ON COLUMN punch_items.closure_note IS 'QUAL-7: what closed the item (done) or why it was voided (void — a reason is required: punch_items_void_rail).';

-- ── 0c. QUAL-11: the turnover review history, append-only ────────────────────
CREATE TABLE IF NOT EXISTS turnover_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES turnover_items(id) ON DELETE CASCADE,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open','received','accepted','rejected','waived')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open','received','accepted','rejected','waived')),
  kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review','reopen','nonconformance')),
  reviewer UUID,
  reviewer_name TEXT,
  note TEXT,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS turnover_review_events_item_idx ON turnover_review_events (item_id, created_at);
CREATE INDEX IF NOT EXISTS turnover_review_events_project_idx ON turnover_review_events (project_id, kind);
COMMENT ON TABLE turnover_review_events IS
  'QUAL-11: append-only review history for turnover items — every status change (written by turnover_items_record_review_event in the same statement), a rejection as a nonconformance, a reopen with its reason. No client writes it.';
COMMENT ON COLUMN turnover_review_events.reviewer IS
  'auth.uid() of the writer; NULL only for the service pass (restore, server route, SQL editor) with no reviewed_by, or a backfilled decision that never recorded its reviewer.';

ALTER TABLE turnover_review_events ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON turnover_review_events FROM authenticated, anon;

DROP POLICY IF EXISTS turnover_review_events_member_read ON turnover_review_events;
CREATE POLICY turnover_review_events_member_read ON turnover_review_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = turnover_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));

-- No client INSERT: the history is the database's to write (§3).
DROP POLICY IF EXISTS turnover_review_events_insert_own ON turnover_review_events;

-- One history row per decision already made, so a reopen never erases it.
-- A row whose org is mismatched is skipped (inventory) — its event would
-- carry the same corruption.
INSERT INTO turnover_review_events (org_id, project_id, item_id, from_status, to_status, kind, reviewer, reviewer_name, note, document_id, created_at)
SELECT t.org_id, t.project_id, t.id, NULL, t.status,
       CASE WHEN t.status = 'rejected' THEN 'nonconformance' ELSE 'review' END,
       t.reviewed_by, t.reviewed_by_name, t.review_note, t.document_id,
       COALESCE(t.reviewed_at, t.created_at)
  FROM turnover_items t
  JOIN projects p ON p.id = t.project_id
 WHERE t.status IN ('accepted', 'waived', 'rejected')
   AND t.org_id = p.org_id
   AND NOT EXISTS (SELECT 1 FROM turnover_review_events e WHERE e.item_id = t.id);

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

-- ── 2. QUAL-12 header + siblings: org_id is the PROJECT's org ───────────────
-- project_checklists / turnover_items / punch_items authorize on
-- user_owns_project(project_id), which never looks at org_id — so the header
-- (and each sibling) could carry a foreign org, and checklist_items would
-- follow the header. One trigger function, generic over (org_id, project_id);
-- TG_ARGV names the table's ON DELETE SET NULL reference columns.
CREATE OR REPLACE FUNCTION quality_row_org_matches_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_org uuid;
BEGIN
  -- Deleting a document or a party nulls the reference on every row that
  -- cites it (ON DELETE SET NULL is an UPDATE). An UPDATE that changes
  -- nothing but nulling those columns passes, so a legacy mismatched row
  -- never blocks that delete; every other change is checked.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - TG_ARGV) = (to_jsonb(OLD) - TG_ARGV)
     AND NOT EXISTS (SELECT 1 FROM unnest(TG_ARGV) AS a(col)
                      WHERE (to_jsonb(NEW) -> a.col) <> 'null'::jsonb
                        AND (to_jsonb(NEW) -> a.col) IS DISTINCT FROM (to_jsonb(OLD) -> a.col)) THEN
    RETURN NEW;
  END IF;
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
  'QUAL-12: a project-scoped quality row (checklist header, turnover item, punch item, turnover review event) always carries its project org_id — refuses a caller-supplied foreign org on INSERT and UPDATE; an UPDATE that only nulls a reference column named in TG_ARGV (an ON DELETE SET NULL) passes.';

DROP TRIGGER IF EXISTS trg_project_checklists_org_matches_project ON project_checklists;
CREATE TRIGGER trg_project_checklists_org_matches_project
  BEFORE INSERT OR UPDATE ON project_checklists
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project('source_document_id');

DROP TRIGGER IF EXISTS trg_turnover_items_org_matches_project ON turnover_items;
CREATE TRIGGER trg_turnover_items_org_matches_project
  BEFORE INSERT OR UPDATE ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project('document_id', 'party_id');

DROP TRIGGER IF EXISTS trg_punch_items_org_matches_project ON punch_items;
CREATE TRIGGER trg_punch_items_org_matches_project
  BEFORE INSERT OR UPDATE ON punch_items
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project('party_id');

DROP TRIGGER IF EXISTS trg_turnover_review_events_org_matches_project ON turnover_review_events;
CREATE TRIGGER trg_turnover_review_events_org_matches_project
  BEFORE INSERT OR UPDATE ON turnover_review_events
  FOR EACH ROW EXECUTE FUNCTION quality_row_org_matches_project('document_id');

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

-- ── 3. QUAL-11: every status change writes its history row, atomically ──────
CREATE OR REPLACE FUNCTION turnover_items_record_review_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_from text;
  v_stamped boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Born open is not a decision; a restore (the service pass) brings its
    -- own history rows.
    IF NEW.status = 'open' OR auth.uid() IS NULL THEN RETURN NULL; END IF;
    v_from := NULL;
    v_stamped := true;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    v_from := OLD.status;
    -- The lib stamps a fresh reviewed_at with each decision and reopen; the
    -- name and note are carried only when this write stamped them.
    v_stamped := NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at;
  END IF;
  INSERT INTO turnover_review_events (org_id, project_id, item_id, from_status, to_status, kind, reviewer, reviewer_name, note, document_id)
  VALUES (NEW.org_id, NEW.project_id, NEW.id, v_from, NEW.status,
          CASE
            WHEN NEW.status = 'rejected' THEN 'nonconformance'
            WHEN v_from IN ('accepted', 'waived') AND NEW.status NOT IN ('accepted', 'waived') THEN 'reopen'
            ELSE 'review'
          END,
          COALESCE(auth.uid(), NEW.reviewed_by),
          CASE WHEN v_stamped THEN NEW.reviewed_by_name END,
          CASE WHEN v_stamped THEN NEW.review_note END,
          NEW.document_id);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION turnover_items_record_review_event() IS
  'QUAL-11: appends one turnover_review_events row for every status change of a turnover item, in the same statement (a rejection as a nonconformance, a move out of accepted / waived as a reopen).';

DROP TRIGGER IF EXISTS trg_turnover_items_review_event ON turnover_items;
CREATE TRIGGER trg_turnover_items_review_event
  AFTER INSERT OR UPDATE OF status ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION turnover_items_record_review_event();

-- ── 4. SAF-4 / GAP-405: the reason bar at the database ──────────────────────
-- Mirrors reasonProblem() in lib/checklistEngine.ts (the canned list is
-- CANNED_REASONS there; lib/__tests__/qualityRailsMigration.test.ts pins the
-- two together).
CREATE OR REPLACE FUNCTION quality_reason_ok(p_reason text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT length(regexp_replace(COALESCE(p_reason, ''), '\s', '', 'g')) >= 10
     AND lower(regexp_replace(COALESCE(p_reason, ''), '^\s+|\s+$', '', 'g'))
         NOT IN ('decided by reviewer', 'n/a', 'na', 'not applicable', 'reason', 'none', 'ok');
$$;

COMMENT ON FUNCTION quality_reason_ok(text) IS
  'SAF-4 / GAP-405: a reason that meets the record''s bar — at least 10 non-whitespace characters and not a canned string (reasonProblem in lib/checklistEngine.ts).';

CREATE OR REPLACE FUNCTION turnover_items_decision_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('waived', 'rejected')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('accepted', 'waived') AND NEW.status NOT IN ('accepted', 'waived')) THEN
    IF NOT quality_reason_ok(NEW.review_note) THEN
      RAISE EXCEPTION 'A waiver, a rejection or a reopen needs a reason of at least 10 characters in the review note — nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_turnover_items_decision_rail ON turnover_items;
CREATE TRIGGER trg_turnover_items_decision_rail
  BEFORE INSERT OR UPDATE OF status ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION turnover_items_decision_rail();

CREATE OR REPLACE FUNCTION punch_items_void_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'void' AND NOT quality_reason_ok(NEW.closure_note) THEN
    RAISE EXCEPTION 'Voiding a punch item needs a reason of at least 10 characters in the closure note — nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_punch_items_void_rail ON punch_items;
CREATE TRIGGER trg_punch_items_void_rail
  BEFORE INSERT OR UPDATE OF status ON punch_items
  FOR EACH ROW EXECUTE FUNCTION punch_items_void_rail();

CREATE OR REPLACE FUNCTION checklist_items_na_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  -- A machine-stamped write (updated_by NULL: the AI assessment) may propose
  -- N/A; such an N/A carries no person's reason and a completion that
  -- contains one is never citable (checklist_completion_basis).
  IF NEW.updated_by IS NULL THEN RETURN NEW; END IF;
  IF (NEW.status = 'na' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'na'))
     OR (NEW.applicability = 'na' AND (TG_OP = 'INSERT' OR OLD.applicability IS DISTINCT FROM 'na')) THEN
    IF NOT quality_reason_ok(NEW.manual_note) THEN
      RAISE EXCEPTION 'Marking an item not applicable needs a reason of at least 10 characters — nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checklist_items_na_rail ON checklist_items;
CREATE TRIGGER trg_checklist_items_na_rail
  BEFORE INSERT OR UPDATE OF status, applicability ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION checklist_items_na_rail();

-- ── 5. QUAL-2: the database records what a completion rested on ─────────────
CREATE OR REPLACE FUNCTION project_checklists_completion_basis_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  IF NEW.status = 'complete' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'complete' THEN
      NEW.completed_basis := OLD.completed_basis;   -- a completion's basis is never rewritten in place
    ELSE
      NEW.completed_basis := checklist_completion_basis(NEW.id);
    END IF;
  ELSE
    NEW.completed_basis := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION project_checklists_completion_basis_rail() IS
  'QUAL-2: completed_basis is computed by checklist_completion_basis() when a checklist moves to complete, kept while it stays complete, NULL otherwise — a client-supplied value is ignored.';

DROP TRIGGER IF EXISTS trg_project_checklists_completion_basis ON project_checklists;
CREATE TRIGGER trg_project_checklists_completion_basis
  BEFORE INSERT OR UPDATE ON project_checklists
  FOR EACH ROW EXECUTE FUNCTION project_checklists_completion_basis_rail();

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
SELECT 'the project-org trigger lets an ON DELETE SET NULL through (each table passes its reference columns as arguments), so a document or party delete is never blocked',
       (SELECT (SELECT p.prosrc LIKE '%to_jsonb(NEW) - TG_ARGV%' FROM pg_proc p WHERE p.proname = 'quality_row_org_matches_project')
           AND COUNT(*) FILTER (WHERE t.tgnargs >= 1) = 4
          FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE f.proname = 'quality_row_org_matches_project' AND NOT t.tgisinternal),
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
SELECT 'turnover_review_events: exactly one policy — member SELECT, and no INSERT / UPDATE / DELETE / ALL policy (the database writes the history)',
       (SELECT COUNT(*) = 1
           AND COUNT(*) FILTER (WHERE cmd = 'SELECT' AND policyname = 'turnover_review_events_member_read') = 1
          FROM pg_policies WHERE tablename = 'turnover_review_events'),
       NULL
UNION ALL
SELECT 'turnover_review_events: INSERT, UPDATE, DELETE and TRUNCATE revoked from authenticated and anon',
       (SELECT NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'INSERT')
           AND NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'UPDATE')
           AND NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'DELETE')
           AND NOT has_table_privilege('authenticated', 'public.turnover_review_events', 'TRUNCATE')
           AND NOT has_table_privilege('anon', 'public.turnover_review_events', 'INSERT')),
       NULL
UNION ALL
SELECT 'turnover_review_events.kind is constrained to review / reopen / nonconformance',
       (SELECT COUNT(*) = 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE c.relname = 'turnover_review_events' AND k.contype = 'c'
           AND pg_get_constraintdef(k.oid) LIKE '%nonconformance%'),
       NULL
UNION ALL
SELECT 'the history writer fires AFTER INSERT OR UPDATE OF status on turnover_items',
       (SELECT COUNT(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'turnover_items' AND t.tgname = 'trg_turnover_items_review_event' AND NOT t.tgisinternal
           AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT OR UPDATE OF status ON %turnover_items%'),
       NULL
UNION ALL
SELECT 'every decided turnover item whose org matches its project has at least one history row (backfill)',
       (SELECT COUNT(*) = 0 FROM turnover_items t
          JOIN projects p ON p.id = t.project_id
         WHERE t.status IN ('accepted', 'waived', 'rejected') AND t.org_id = p.org_id
           AND NOT EXISTS (SELECT 1 FROM turnover_review_events e WHERE e.item_id = t.id)),
       NULL
UNION ALL
SELECT 'quality_reason_ok mirrors the reason bar: a real reason passes, and blank, short, NULL and canned text fail',
       (SELECT quality_reason_ok('No hydrotest in an electrical-only scope')
           AND NOT quality_reason_ok('decided by reviewer')
           AND NOT quality_reason_ok('Not Applicable')
           AND NOT quality_reason_ok('too short')
           AND NOT quality_reason_ok('   ')
           AND NOT quality_reason_ok(NULL)),
       NULL
UNION ALL
SELECT 'the reason rails are live: turnover_items (waive / reject / reopen), punch_items (void), checklist_items (a person''s N/A)',
       (SELECT COUNT(*) = 3 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal
           AND ((c.relname = 'turnover_items' AND t.tgname = 'trg_turnover_items_decision_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status ON %')
             OR (c.relname = 'punch_items' AND t.tgname = 'trg_punch_items_void_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status ON %')
             OR (c.relname = 'checklist_items' AND t.tgname = 'trg_checklist_items_na_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status, applicability ON %'))),
       NULL
UNION ALL
SELECT 'each reason rail checks its own column with quality_reason_ok and lets only the service pass through',
       (SELECT COUNT(*) = 3 FROM pg_proc p
         WHERE p.prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW%'
           AND ((p.proname = 'turnover_items_decision_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.review_note)%')
             OR (p.proname = 'punch_items_void_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.closure_note)%')
             OR (p.proname = 'checklist_items_na_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.manual_note)%'))),
       NULL
UNION ALL
SELECT 'the five new trigger functions are SECURITY DEFINER with search_path pinned to public',
       (SELECT COUNT(*) = 5 FROM pg_proc p
         WHERE p.proname IN ('turnover_items_record_review_event', 'turnover_items_decision_rail', 'punch_items_void_rail',
                             'checklist_items_na_rail', 'project_checklists_completion_basis_rail')
           AND p.prosecdef AND COALESCE(array_to_string(p.proconfig, ',') LIKE '%search_path=public%', false)),
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
SELECT 'checklist_completion_basis: a checklist with no green a person decided is auto (probed on an id with no items)',
       (SELECT checklist_completion_basis(gen_random_uuid()) = 'auto'),
       NULL
UNION ALL
SELECT 'the completion-basis rail is live on project_checklists (BEFORE INSERT OR UPDATE) and ignores a client value',
       (SELECT COUNT(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE c.relname = 'project_checklists' AND t.tgname = 'trg_project_checklists_completion_basis' AND NOT t.tgisinternal
           AND f.prosrc LIKE '%NEW.completed_basis := checklist_completion_basis(NEW.id)%'
           AND f.prosrc LIKE '%NEW.completed_basis := OLD.completed_basis%'
           AND f.prosrc LIKE '%NEW.completed_basis := NULL%'),
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
SELECT 'inventory (after backfill): turnover_review_events rows (the backfilled decisions, plus any history since)', NULL,
       (SELECT COUNT(*) FROM turnover_review_events)::text
UNION ALL
SELECT label, NULL, n FROM prj_roundg_quality_inventory;
