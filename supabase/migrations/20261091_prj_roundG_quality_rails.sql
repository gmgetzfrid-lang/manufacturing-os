-- ─────────────────────────────────────────────────────────────────────────────
-- projects Round G — quality rails (J2 QUALITY: PC QUAL-12 / QUAL-11 /
-- QUAL-13 / QUAL-7 / QUAL-2; PT SAF-1..4 rails). One script, one result set.
--
-- The rules the quality data layer (lib/checklists.ts, lib/turnover.ts)
-- checks are ENFORCED here, so a write that bypasses the lib — a direct
-- PostgREST call with the user's own token — meets the same rules
-- (GAP-405: "do not make it a client-side check").
--
-- 0. Helpers, columns and backfills FIRST, before this script creates any
--    trigger. A trigger created earlier in the same transaction fires on the
--    backfill's own UPDATE / INSERT: the project-org trigger (§2) would abort
--    the whole script on one legacy row whose org is mismatched, and the
--    completion-basis rail (§5) would keep a NULL basis.
--    0h. quality_reason_ok(text) is THE reason bar — it mirrors
--        reasonProblem() (lib/checklistEngine.ts): at least 10 characters
--        once whitespace (Unicode's included — a no-break space is not a
--        reason) and zero-width characters are stripped, and none of the
--        canned strings; quality_reason_key(text) is the same normalised form
--        (zero-width characters dropped, whitespace runs collapsed, trimmed,
--        lower-cased), which is how "a NEW note" is judged — the old note
--        plus a trailing space is not new. Both character classes are pinned
--        to the lib's REASON_SPACE_CLASS / REASON_INVISIBLE_CLASS.
--        quality_actor_name(uid) is the name a signed-in writer's decision
--        records: the local part of the SIGN-IN email in auth.users (what the
--        lib shows as the actor), which the user cannot edit from the app —
--        never the client's value, and never public.users.email (self-editable
--        under users_own). quality_try_uuid(text) is a cast that yields NULL
--        on junk instead of aborting.
--    0a. QUAL-2 — project_checklists.completed_basis ('human' | 'auto'): what
--        a completion rested on; only 'human' is citable as evidence by
--        another checklist (lib/checklists.ts gatherProjectEvidenceState).
--        checklist_completion_basis(id) is THE rule — the same one
--        completionBasis() applies in lib/checklistEngine.ts: 'auto' when an
--        applicable item is neither green nor N/A (a legacy completion; §5
--        refuses a new one), when a green carries no person's reason (no
--        note that meets the bar — a person-attached chip alone is not a
--        reason), when an N/A carries no reason that meets the bar (the
--        assessment's, or a legacy one), or when no green was decided by a
--        person (an all-N/A checklist proves nothing); otherwise 'human'. A
--        note counts as a person's reason ONLY when quality_reason_ok()
--        holds — 'x' is not one. The backfill calls it for every completed
--        checklist (a NULL or stale basis is rewritten; a re-run changes
--        nothing further).
--    0b. QUAL-7 — punch_items gains closed_by_name, description, location and
--        closure_note (nullable text): a closure names its closer and what
--        closed it, and done is distinguishable from void on the row.
--    0c. QUAL-11 — turnover_review_events: an append-only review history
--        (reviewer, date, note, from → to, the reviewed document); a
--        rejection is kind = 'nonconformance', a move out of accepted /
--        waived is kind = 'reopen'. Members read it; NO client writes it
--        (INSERT / UPDATE / DELETE / TRUNCATE revoked, no write policy): §3's
--        trigger writes it in the same statement as the decision. item_id is
--        a plain uuid, NOT a foreign key: the history outlives its item —
--        deleting a decided turnover item leaves its history standing (no
--        cascade; the project's own deletion still takes it, QUAL-3). The
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
--    row, atomically with the change. The reviewer is auth.uid() and the
--    reviewer's NAME is quality_actor_name(auth.uid()), never the client's.
--    The note is NEW's only when this write CHANGED it (by
--    quality_reason_key) — a note carried over from an earlier decision
--    belongs to that decision's row, not this one, even when the write
--    stamps a fresh reviewed_at. A restore (the service pass) that inserts a
--    decided item gets ONE row from the item's own stamps, as the backfill
--    does, and only when the item has no history yet: the history table
--    itself is never imported (lib/dataRestore.ts IMMUTABLE_TABLES, SURF-8).
-- 4. SAF-4 / GAP-405 — the reason rails. A decision needs its OWN reason: a
--    turnover item moving to waived / rejected or out of accepted / waived
--    (a reopen), a punch item moving to void, and a person's status or
--    applicability change on a checklist item each need a note that CHANGED
--    (by quality_reason_key — the note already on the row belongs to the
--    earlier decision) and meets the bar. While a decision stands its record
--    stands: a waived / rejected / accepted turnover item keeps its note,
--    reviewer, date and reviewed document (only a document delete may null
--    the reference — an ON DELETE SET NULL, one trigger level down), and a
--    closed punch item its closer and date — a void its reason too — until
--    the next decision; a person's note on a checklist item is replaced only
--    by one that meets the bar, never cleared. The reviewer / closer (and
--    the date) a signed-in decision records is the caller's and the
--    server's — never client-supplied.
--    checklist_items_decision_rail() draws the line between the machine and
--    a person. updated_by NULL is the MACHINE actor's mark (DEC-35), and the
--    evidence sweep and the AI assessment run in the browser under the
--    user's own token (lib/checklists.ts runAutoEvidence / applyAssessment),
--    so the database cannot tell them from a direct PATCH by who sent them.
--    It bounds what a machine-stamped write may DO instead, to exactly what
--    each machine writes: updated_by_name is one of the two sentinels
--    (MACHINE_ACTOR_SWEEP / MACHINE_ACTOR_ASSESSMENT, pinned to the lib);
--    never on an item a person decided (any visible note — an empty or
--    blank one is none — or a person-attached chip); the note and every
--    non-auto chip left as they were. The sweep changes only status (to
--    satisfied / needs evidence) and evidence (written as a list), on an
--    in-scope item, and a green it sets carries a citation that RESOLVES
--    (checklist_auto_citation_ok, every branch in the item's org: an admitted
--    document of the workspace — Issued / Locked, a current version, not an
--    unapproved external submission; no provenance at all is admitted — an
--    accepted turnover item of this project, or a completed 'human' MI
--    checklist of this project). A legacy evidence value stored as one
--    object is read as a single chip (checklist_evidence), as the lib reads
--    it. The assessment changes only applicability, ai_rationale and status
--    (to N/A with applicability N/A, or N/A back to open with applicability
--    applies), and never N/As an item that is satisfied or carries evidence
--    (QUAL-5). Neither touches
--    text, section, seq or anything else. All a machine-stamped write can
--    produce — a note-less N/A, a cited sweep green — is 'auto' by the basis
--    rule, never citable. A row born with no actor (createChecklist) must be
--    born undecided. Every other signed-in write is a PERSON's: stamped with
--    the caller's uid and name, and it leaves the machine's auto chips as
--    they were. An item leaves only with its checklist — a signed-in
--    single-item DELETE is refused (a cascade from deleting the checklist,
--    project or org runs one trigger level down and passes) — and never
--    moves to another checklist. Every item write first takes a SHARE lock
--    on its checklist's row, so it serialises with a completion (whose
--    UPDATE holds that row's lock) instead of racing it — waiting at most
--    500 ms, so against a delete that cascades into it the item write gives
--    way instead of deadlocking; and a completed
--    checklist is frozen — a signed-in write may not insert or change its
--    items until it is reopened (which clears the basis). The tab offers no
--    item control on a completed checklist. For signed-in writes the stored
--    basis therefore cannot go stale behind a completion; the service pass
--    (below) is not held to that.
--    The service pass (auth.uid() IS NULL — restores, server routes, the SQL
--    editor) passes, as in 20261056 / 20261062. NARROWS.
-- 5. QUAL-2 — project_checklists_completion_basis_rail(): the completion
--    GATE at the database — a signed-in move to complete is refused while the
--    checklist has no items or any applicable item is neither satisfied nor
--    N/A (setChecklistStatus's gate, the same predicate as isBlockingItem()).
--    Then the DATABASE records completed_basis — computed by
--    checklist_completion_basis() when the status moves to complete, kept
--    while it stays complete (its items are frozen, §4), NULL otherwise; a
--    client-supplied value is ignored. While complete, its kind and its
--    project are frozen too (a QA/QC completion never becomes a citable MI
--    one). NARROWS.
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
--   * completed checklists that backfill to 'auto', by reason; checklist
--     items whose note is under the bar (legacy: they keep the automated
--     passes out, and count as no person's reason); sweep citations that
--     name no row (legacy chips — the next sweep re-cites them with the row
--     they rest on).
--   * decided turnover items (their history is backfilled), those with no
--     reviewer uid on record, and those skipped because their org is
--     mismatched; waived / rejected items whose note is under the bar.
-- The bar is not yet in the database when the inventory runs, so it reads a
-- session-local copy (pg_temp.prj_roundg_reason_ok — the body of
-- quality_reason_ok, pinned equal by the shape test).
-- The inventory's label column is `label`, never a reserved word: the final
-- SELECT references it bare (a bare `check` column ref is a syntax error).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DEC-30 inventory — BEFORE the transaction; counts only, never rows ───────
CREATE OR REPLACE FUNCTION pg_temp.prj_roundg_reason_ok(p_reason text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT length(regexp_replace(COALESCE(p_reason, ''), '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u00ad\u180e\u200b-\u200d\u2060-\u2064]', '', 'g')) >= 10
     AND COALESCE(lower(btrim(regexp_replace(regexp_replace(COALESCE(p_reason, ''), '[\u00ad\u180e\u200b-\u200d\u2060-\u2064]', '', 'g'), '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))), '')
         NOT IN ('decided by reviewer', 'n/a', 'na', 'not applicable', 'reason', 'none', 'ok');
$$;

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
SELECT 'inventory: completed checklists with an applicable item neither green nor N/A (QUAL-2 — not a valid completion; backfills to auto; the gate refuses a new one)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.applicability <> 'na' AND i.status NOT IN ('satisfied', 'na')))::text
UNION ALL
SELECT 'inventory: completed checklists with a green item no person gave a reason for (QUAL-2 — the sweep''s, a legacy one, or a person chip with no note that meets the bar; backfills to auto; not citable until verified and re-completed)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.status = 'satisfied' AND i.applicability <> 'na'
                AND NOT pg_temp.prj_roundg_reason_ok(i.manual_note)))::text
UNION ALL
SELECT 'inventory: completed checklists with an N/A carrying no reason that meets the bar (QUAL-2 — the assessment''s, a legacy or a short one; backfills to auto)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND (i.status = 'na' OR i.applicability = 'na')
                AND NOT pg_temp.prj_roundg_reason_ok(i.manual_note)))::text
UNION ALL
SELECT 'inventory: completed checklists with no green item a person decided (QUAL-2 — nothing on them was verified by anyone; backfills to auto)',
       (SELECT COUNT(*) FROM project_checklists c
         WHERE c.status = 'complete'
           AND NOT EXISTS (
             SELECT 1 FROM checklist_items i
              WHERE i.checklist_id = c.id
                AND i.status = 'satisfied' AND i.applicability <> 'na'
                AND pg_temp.prj_roundg_reason_ok(i.manual_note)))::text
UNION ALL
SELECT 'inventory: completed checklists (all)',
       (SELECT COUNT(*) FROM project_checklists WHERE status = 'complete')::text
UNION ALL
SELECT 'inventory: checklist_items whose note is under the bar (legacy — kept, never rewritten; they keep the sweep and the assessment out and count as no person''s reason; a person replaces one with a reason, never clears it)',
       (SELECT COUNT(*) FROM checklist_items i
         WHERE i.manual_note IS NOT NULL AND NOT pg_temp.prj_roundg_reason_ok(i.manual_note))::text
UNION ALL
SELECT 'inventory: satisfied items citing the sweep with no row behind the citation (legacy auto chips with no documentId / turnoverItemId / checklistId — the next sweep re-cites them with the row they rest on; never this script)',
       (SELECT COUNT(*) FROM checklist_items i
         WHERE i.status = 'satisfied'
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                        WHERE e->>'source' = 'auto')
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.evidence) = 'array' THEN i.evidence ELSE '[]'::jsonb END) e
                            WHERE e->>'source' = 'auto'
                              AND (e ? 'documentId' OR e ? 'turnoverItemId' OR e ? 'checklistId')))::text
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

-- ── 0h. The reason bar and the actor's name — the rules every rail reads ────
-- Mirrors reasonProblem() in lib/checklistEngine.ts (the canned list is
-- CANNED_REASONS there; lib/__tests__/qualityRailsMigration.test.ts pins the
-- two together). Created first: checklist_completion_basis() reads it.
CREATE OR REPLACE FUNCTION quality_reason_ok(p_reason text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT length(regexp_replace(COALESCE(p_reason, ''), '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u00ad\u180e\u200b-\u200d\u2060-\u2064]', '', 'g')) >= 10
     AND COALESCE(lower(btrim(regexp_replace(regexp_replace(COALESCE(p_reason, ''), '[\u00ad\u180e\u200b-\u200d\u2060-\u2064]', '', 'g'), '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))), '')
         NOT IN ('decided by reviewer', 'n/a', 'na', 'not applicable', 'reason', 'none', 'ok');
$$;

COMMENT ON FUNCTION quality_reason_ok(text) IS
  'SAF-4 / GAP-405: a reason that meets the record''s bar — at least 10 characters once whitespace (Unicode''s included) and zero-width characters are stripped, and not a canned string (reasonProblem in lib/checklistEngine.ts).';

-- The normalised form a note is compared in: "a NEW note" is one whose key
-- differs (zero-width characters dropped, whitespace runs collapsed, trimmed,
-- lower-cased — the old note plus a trailing space is not new). The same
-- expression as quality_reason_ok's canned check; reasonKey() in the lib.
CREATE OR REPLACE FUNCTION quality_reason_key(p_reason text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(lower(btrim(regexp_replace(regexp_replace(COALESCE(p_reason, ''), '[\u00ad\u180e\u200b-\u200d\u2060-\u2064]', '', 'g'), '[\s\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'))), '');
$$;

-- A uuid from text, or NULL for anything else (a citation id is client JSON).
CREATE OR REPLACE FUNCTION quality_try_uuid(p_text text)
RETURNS uuid
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid END;
$$;

CREATE OR REPLACE FUNCTION quality_actor_name(p_uid uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT NULLIF(split_part(u.email, '@', 1), '') FROM auth.users u WHERE u.id = p_uid;
$$;

COMMENT ON FUNCTION quality_actor_name(uuid) IS
  'QUAL-11 / QUAL-6: the name a signed-in writer''s quality decision records — the local part of the sign-in email in auth.users (the lib''s actor name), which the user cannot edit from the app; never public.users.email (self-editable under users_own). The rails stamp it; a client-supplied name is never trusted.';
-- Read by the SECURITY DEFINER rails only: no client looks a uid up by it.
REVOKE EXECUTE ON FUNCTION quality_actor_name(uuid) FROM PUBLIC, anon, authenticated;

-- ── 0a. QUAL-2: what a completion rested on — the rule, then the backfill ────
ALTER TABLE project_checklists ADD COLUMN IF NOT EXISTS completed_basis TEXT
  CHECK (completed_basis IS NULL OR completed_basis IN ('human','auto'));
COMMENT ON COLUMN project_checklists.completed_basis IS
  'QUAL-2: human = every applicable item green or N/A, every green and every N/A carries a person''s reason that meets the bar (a chip alone is not one), and at least one green was decided by a person; auto = otherwise. Only human is citable as evidence elsewhere. Recorded by the database (checklist_completion_basis), never by the client.';

CREATE OR REPLACE FUNCTION checklist_completion_basis(p_checklist_id uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT CASE
    -- an applicable item neither green nor N/A: not a completion at all (legacy only — the gate refuses a new one)
    WHEN EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND i.applicability <> 'na' AND i.status NOT IN ('satisfied', 'na'))
      THEN 'auto'
    -- a green no person gave a reason for: no note that meets the bar (a person-attached chip alone is not a reason)
    WHEN EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND i.status = 'satisfied' AND i.applicability <> 'na'
         AND NOT quality_reason_ok(i.manual_note))
      THEN 'auto'
    -- an N/A with no reason that meets the bar (the assessment's, a legacy or a short one)
    WHEN EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND (i.status = 'na' OR i.applicability = 'na')
         AND NOT quality_reason_ok(i.manual_note))
      THEN 'auto'
    -- no green a person decided: nothing on the checklist was verified by anyone
    WHEN NOT EXISTS (
      SELECT 1 FROM checklist_items i
       WHERE i.checklist_id = p_checklist_id
         AND i.status = 'satisfied' AND i.applicability <> 'na'
         AND quality_reason_ok(i.manual_note))
      THEN 'auto'
    ELSE 'human'
  END;
$$;

COMMENT ON FUNCTION checklist_completion_basis(uuid) IS
  'QUAL-2: the completion basis of a checklist, by the rule completionBasis() applies in lib/checklistEngine.ts (a note counts as a person''s reason only when quality_reason_ok holds). Called by the backfill below and by project_checklists_completion_basis_rail.';

-- On a re-run the project-org trigger already exists; it is re-created in §2,
-- so drop it here and the backfill meets the same state as a first run.
DROP TRIGGER IF EXISTS trg_project_checklists_org_matches_project ON project_checklists;

-- Every completed checklist carries the rule's answer: a NULL basis is
-- filled, and a re-run over an earlier draft corrects any stale one.
UPDATE project_checklists c
   SET completed_basis = checklist_completion_basis(c.id)
 WHERE c.status = 'complete'
   AND c.completed_basis IS DISTINCT FROM checklist_completion_basis(c.id);

-- ── 0b. QUAL-7: the punch record ─────────────────────────────────────────────
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closed_by_name TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS closure_note TEXT;
COMMENT ON COLUMN punch_items.closure_note IS 'QUAL-7: what closed the item (done) or why it was voided (void — a reason of its own is required, and it stands while the void does: punch_items_void_rail).';

-- ── 0c. QUAL-11: the turnover review history, append-only ────────────────────
CREATE TABLE IF NOT EXISTS turnover_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id UUID NOT NULL,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open','received','accepted','rejected','waived')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open','received','accepted','rejected','waived')),
  kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review','reopen','nonconformance')),
  reviewer UUID,
  reviewer_name TEXT,
  note TEXT,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- An earlier draft of this script tied item_id to turnover_items ON DELETE
-- CASCADE; a history row must outlive its item, so no such key survives a re-run.
ALTER TABLE turnover_review_events DROP CONSTRAINT IF EXISTS turnover_review_events_item_id_fkey;
CREATE INDEX IF NOT EXISTS turnover_review_events_item_idx ON turnover_review_events (item_id, created_at);
CREATE INDEX IF NOT EXISTS turnover_review_events_project_idx ON turnover_review_events (project_id, kind);
COMMENT ON TABLE turnover_review_events IS
  'QUAL-11: append-only review history for turnover items — every status change (written by turnover_items_record_review_event in the same statement), a rejection as a nonconformance, a reopen with its reason. No client writes it; a restore never imports it (IMMUTABLE_TABLES).';
COMMENT ON COLUMN turnover_review_events.item_id IS
  'The turnover item''s id, kept as a plain value (no foreign key): the history outlives the item — deleting a decided item leaves its history standing.';
COMMENT ON COLUMN turnover_review_events.reviewer IS
  'auth.uid() of the writer; NULL only for the service pass (restore, server route, SQL editor) with no reviewed_by, or a backfilled decision that never recorded its reviewer.';
COMMENT ON COLUMN turnover_review_events.reviewer_name IS
  'For a signed-in writer, read from the users profile (quality_actor_name) — never the client''s; for the service pass and the backfill, the name the item row carries.';

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
  v_note text;
  v_at timestamptz := NOW();
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Born open is not a decision.
    IF NEW.status = 'open' THEN RETURN NULL; END IF;
    IF auth.uid() IS NULL THEN
      -- A restore: the history table is never imported (IMMUTABLE_TABLES),
      -- so a restored decided item gets ONE row from its own stamps, as the
      -- backfill does — and none when its history already stands.
      IF NEW.status NOT IN ('accepted', 'waived', 'rejected')
         OR EXISTS (SELECT 1 FROM turnover_review_events e WHERE e.item_id = NEW.id) THEN
        RETURN NULL;
      END IF;
      v_at := COALESCE(NEW.reviewed_at, NEW.created_at, NOW());
    END IF;
    v_from := NULL;
    v_note := NEW.review_note;
  ELSE
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
    v_from := OLD.status;
    -- The note is NEW's only when this write CHANGED it; a note carried over
    -- (a fresh reviewed_at or not) belongs to the earlier decision's row.
    v_note := CASE WHEN quality_reason_key(NEW.review_note) IS DISTINCT FROM quality_reason_key(OLD.review_note)
                   THEN NEW.review_note END;
  END IF;
  INSERT INTO turnover_review_events (org_id, project_id, item_id, from_status, to_status, kind, reviewer, reviewer_name, note, document_id, created_at)
  VALUES (NEW.org_id, NEW.project_id, NEW.id, v_from, NEW.status,
          CASE
            WHEN NEW.status = 'rejected' THEN 'nonconformance'
            WHEN v_from IN ('accepted', 'waived') AND NEW.status NOT IN ('accepted', 'waived') THEN 'reopen'
            ELSE 'review'
          END,
          COALESCE(auth.uid(), NEW.reviewed_by),
          CASE WHEN auth.uid() IS NOT NULL THEN quality_actor_name(auth.uid()) ELSE NEW.reviewed_by_name END,
          v_note,
          NEW.document_id,
          v_at);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION turnover_items_record_review_event() IS
  'QUAL-11: appends one turnover_review_events row for every status change of a turnover item, in the same statement (a rejection as a nonconformance, a move out of accepted / waived as a reopen) — the reviewer and their sign-in name from the session, the note only when this write changed it; a restored decided item gets one row from its own stamps.';

DROP TRIGGER IF EXISTS trg_turnover_items_review_event ON turnover_items;
CREATE TRIGGER trg_turnover_items_review_event
  AFTER INSERT OR UPDATE OF status ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION turnover_items_record_review_event();

-- ── 4. SAF-4 / GAP-405: the reason rails ─────────────────────────────────────
CREATE OR REPLACE FUNCTION turnover_items_decision_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_moved boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  v_moved := TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status;
  IF NOT v_moved THEN
    -- A standing decision keeps its record — the note, the reviewer, the
    -- date and the reviewed document — until the next decision (its history
    -- row carries them). Only a document delete may null the reference: an
    -- ON DELETE SET NULL runs one trigger level down.
    IF OLD.status IN ('accepted', 'waived', 'rejected')
       AND (NEW.review_note IS DISTINCT FROM OLD.review_note
            OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
            OR NEW.reviewed_by_name IS DISTINCT FROM OLD.reviewed_by_name
            OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
            OR (NEW.document_id IS DISTINCT FROM OLD.document_id
                AND NOT (NEW.document_id IS NULL AND pg_trigger_depth() > 1))) THEN
      RAISE EXCEPTION 'A standing decision keeps its reason, its reviewer and its reviewed document — reopen the item or make a new decision; nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IN ('waived', 'rejected')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('accepted', 'waived') AND NEW.status NOT IN ('accepted', 'waived')) THEN
    -- A waiver, a rejection or a reopen needs its OWN reason: the note on
    -- the row belongs to the earlier decision (compared normalised).
    IF (TG_OP = 'UPDATE' AND quality_reason_key(NEW.review_note) IS NOT DISTINCT FROM quality_reason_key(OLD.review_note))
       OR NOT quality_reason_ok(NEW.review_note) THEN
      RAISE EXCEPTION 'A waiver, a rejection or a reopen needs its own reason of at least 10 characters in the review note — nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- The reviewer on the row is the caller, named from the sign-in email, and
  -- the date is the server's: stamped on every decision and reopen, and on
  -- any write that names a reviewer.
  IF (v_moved AND (NEW.status IN ('accepted', 'waived', 'rejected')
                   OR (TG_OP = 'UPDATE' AND OLD.status IN ('accepted', 'waived'))))
     OR (NEW.reviewed_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by))
     OR (NEW.reviewed_by_name IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.reviewed_by_name IS DISTINCT FROM OLD.reviewed_by_name)) THEN
    NEW.reviewed_by := auth.uid();
    NEW.reviewed_by_name := quality_actor_name(auth.uid());
    NEW.reviewed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_turnover_items_decision_rail ON turnover_items;
CREATE TRIGGER trg_turnover_items_decision_rail
  BEFORE INSERT OR UPDATE OF status, review_note, reviewed_by, reviewed_by_name, reviewed_at, document_id ON turnover_items
  FOR EACH ROW EXECUTE FUNCTION turnover_items_decision_rail();

CREATE OR REPLACE FUNCTION punch_items_void_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_moved boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  v_moved := TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status;
  IF NOT v_moved THEN
    -- A standing closure keeps its closer and date, and a standing void its
    -- reason, until the item is reopened.
    IF NEW.status IN ('done', 'void')
       AND (NEW.closed_by IS DISTINCT FROM OLD.closed_by
            OR NEW.closed_by_name IS DISTINCT FROM OLD.closed_by_name
            OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
      RAISE EXCEPTION 'A closed punch item keeps its closer and its date — reopen the item to change them; nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'void' AND NEW.closure_note IS DISTINCT FROM OLD.closure_note THEN
      RAISE EXCEPTION 'A void keeps its reason — reopen the item to change it; nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'void'
     AND ((TG_OP = 'UPDATE' AND quality_reason_key(NEW.closure_note) IS NOT DISTINCT FROM quality_reason_key(OLD.closure_note))
          OR NOT quality_reason_ok(NEW.closure_note)) THEN
    RAISE EXCEPTION 'Voiding a punch item needs its own reason of at least 10 characters in the closure note — nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The closer on the row is the caller, named from the sign-in email, and a
  -- closure's date is the server's.
  IF (v_moved AND NEW.status IN ('done', 'void'))
     OR ((NEW.closed_by IS NOT NULL OR NEW.closed_by_name IS NOT NULL)
         AND (TG_OP = 'INSERT' OR NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_by_name IS DISTINCT FROM OLD.closed_by_name)) THEN
    NEW.closed_by := auth.uid();
    NEW.closed_by_name := quality_actor_name(auth.uid());
  END IF;
  IF v_moved AND NEW.status IN ('done', 'void') THEN
    NEW.closed_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_punch_items_void_rail ON punch_items;
CREATE TRIGGER trg_punch_items_void_rail
  BEFORE INSERT OR UPDATE OF status, closure_note, closed_by, closed_by_name, closed_at ON punch_items
  FOR EACH ROW EXECUTE FUNCTION punch_items_void_rail();

-- The evidence as a list of chips: an array as it stands, a legacy value
-- stored as one object as a single chip, anything else as none — the same
-- reading as normalizeEvidence() in lib/checklistEngine.ts.
CREATE OR REPLACE FUNCTION checklist_evidence(p_evidence jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE jsonb_typeof(p_evidence)
           WHEN 'array' THEN p_evidence
           WHEN 'object' THEN jsonb_build_array(p_evidence)
           ELSE '[]'::jsonb
         END;
$$;

-- The chips of one kind, in order: p_auto = true gives the machine's
-- (source 'auto'), false every other element (a person's). No machine write
-- may change the person's, and no person's write the machine's.
CREATE OR REPLACE FUNCTION checklist_chips(p_evidence jsonb, p_auto boolean)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(checklist_evidence(p_evidence)) WITH ORDINALITY AS e(value, ordinality)
   WHERE (e.value->>'source' IS NOT DISTINCT FROM 'auto') = p_auto;
$$;
-- An earlier draft's single-purpose helper.
DROP FUNCTION IF EXISTS checklist_non_auto_chips(jsonb);

-- A machine green's citation must RESOLVE to the row it rests on — the
-- register the sweep reads (lib/checklists.ts gatherProjectEvidenceState):
-- an admitted document of the item's workspace (Issued / Locked, a current
-- version, not an unapproved external submission — EVIDENCE_DOCUMENT_STATUSES;
-- a version with no provenance, the bulk upload's and every version older
-- than 20260823, is admitted, as the lib admits it), an accepted turnover
-- item of this project and workspace, or another checklist of this project
-- and workspace completed as a 'human' MI checklist. A label alone proves
-- nothing. Every branch is tied to the item's org (a legacy row whose org
-- differs from its project's never resolves).
CREATE OR REPLACE FUNCTION checklist_auto_citation_ok(p_checklist_id uuid, p_org_id uuid, p_evidence jsonb)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(checklist_evidence(p_evidence)) e
      JOIN project_checklists c ON c.id = p_checklist_id
     WHERE e->>'source' = 'auto'
       AND (EXISTS (SELECT 1 FROM documents d
                      JOIN document_versions v ON v.id = d.current_version_id
                     WHERE d.id = quality_try_uuid(e->>'documentId') AND d.org_id = p_org_id
                       AND d.status IN ('Issued', 'Locked')
                       AND NOT (v.provenance IS NOT DISTINCT FROM 'external' AND v.review_state IS DISTINCT FROM 'approved'))
         OR EXISTS (SELECT 1 FROM turnover_items t
                     WHERE t.id = quality_try_uuid(e->>'turnoverItemId') AND t.org_id = p_org_id
                       AND t.project_id = c.project_id AND t.status = 'accepted')
         OR EXISTS (SELECT 1 FROM project_checklists m
                     WHERE m.id = quality_try_uuid(e->>'checklistId') AND m.org_id = p_org_id
                       AND m.project_id = c.project_id AND m.id <> c.id
                       AND m.kind = 'mi' AND m.status = 'complete' AND m.completed_basis = 'human')));
$$;

-- The earlier draft's N/A-only rail is replaced by the decision rail below.
DROP TRIGGER IF EXISTS trg_checklist_items_na_rail ON checklist_items;
DROP FUNCTION IF EXISTS checklist_items_na_rail();

CREATE OR REPLACE FUNCTION checklist_items_decision_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_frozen boolean;
  v_decides boolean;
  v_note_changed boolean;
  v_changed text[];
  v_lock_timeout text;
BEGIN
  IF auth.uid() IS NULL THEN                         -- service pass: restores, server routes, the SQL editor
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- (a) An item leaves only with its checklist. The app never deletes one
  --     item (an unmet line deleted, the completion lands); a cascade from
  --     deleting the checklist, the project or the org runs one trigger
  --     level down and passes. Nor does an item move between checklists.
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'A checklist item is never deleted on its own — reopen, void or delete the checklist instead; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.checklist_id IS DISTINCT FROM OLD.checklist_id THEN
    RAISE EXCEPTION 'A checklist item never moves to another checklist; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (b) Serialise with the completion: take a SHARE lock on the checklist's
  --     row (it conflicts with the lock a completing UPDATE holds, not with
  --     other item writes), then read its status. A completed checklist is
  --     frozen until it is reopened (which clears its basis). The wait is
  --     capped at 500 ms — under deadlock_timeout — so against a checklist,
  --     project or org delete (which holds the checklist row and cascades
  --     into the item this write already holds) the item write gives way
  --     with a lock timeout (55P03; the lib says "try again") instead of
  --     deadlocking; a completion holds the row for milliseconds.
  v_lock_timeout := current_setting('lock_timeout');
  PERFORM set_config('lock_timeout', '500ms', true);
  PERFORM 1 FROM project_checklists c WHERE c.id = NEW.checklist_id FOR SHARE;
  PERFORM set_config('lock_timeout', v_lock_timeout, true);
  SELECT c.status = 'complete' INTO v_frozen FROM project_checklists c WHERE c.id = NEW.checklist_id;
  IF COALESCE(v_frozen, false) THEN
    RAISE EXCEPTION 'This checklist is complete — reopen it before changing its items; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- (c) updated_by NULL is the MACHINE actor's mark (DEC-35).
  IF NEW.updated_by IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      -- A row born with no actor (createChecklist) is born undecided.
      IF NEW.status <> 'open' OR NEW.applicability = 'na' OR NEW.manual_note IS NOT NULL
         OR checklist_chips(NEW.evidence, false) <> '[]'::jsonb
         OR checklist_chips(NEW.evidence, true) <> '[]'::jsonb
         OR (NEW.updated_by_name IS NOT NULL AND NEW.updated_by_name NOT IN ('evidence sweep', 'AI assessment')) THEN
        RAISE EXCEPTION 'A new checklist item with no actor is born open, with no note and no evidence — a decision carries the uid of the person who made it; nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.updated_by_name IS NULL OR NEW.updated_by_name NOT IN ('evidence sweep', 'AI assessment') THEN
      RAISE EXCEPTION 'updated_by NULL is the machine actor''s mark (the evidence sweep or the AI assessment) — a person''s write carries their uid; nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF quality_reason_key(OLD.manual_note) IS NOT NULL OR checklist_chips(OLD.evidence, false) @> '[{"source": "manual"}]'::jsonb THEN
      RAISE EXCEPTION 'A person decided this item (a note or an attached chip) — the evidence sweep and the assessment never change it; nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.manual_note IS DISTINCT FROM OLD.manual_note
       OR checklist_chips(NEW.evidence, false) IS DISTINCT FROM checklist_chips(OLD.evidence, false) THEN
      RAISE EXCEPTION 'The machine actor writes no note and attaches no person''s chip — nothing was changed.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Each machine writes its own columns and nothing else.
    SELECT COALESCE(array_agg(n.key), '{}') INTO v_changed
      FROM jsonb_each(to_jsonb(NEW)) n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
    IF NEW.updated_by_name = 'evidence sweep' THEN
      -- runAutoEvidence: status (satisfied / needs evidence) and its own
      -- citations, on an in-scope item.
      IF NOT v_changed <@ ARRAY['status', 'evidence', 'updated_at', 'updated_by', 'updated_by_name']
         OR OLD.applicability = 'na' OR OLD.status = 'na'
         OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('satisfied', 'needs_evidence'))
         OR (NEW.evidence IS DISTINCT FROM OLD.evidence AND jsonb_typeof(NEW.evidence) IS DISTINCT FROM 'array') THEN
        RAISE EXCEPTION 'The evidence sweep changes only an in-scope item''s status (satisfied / needs evidence) and its own citations — nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.status = 'satisfied'
         AND (OLD.status IS DISTINCT FROM 'satisfied' OR NEW.evidence IS DISTINCT FROM OLD.evidence)
         AND NOT checklist_auto_citation_ok(NEW.checklist_id, NEW.org_id, NEW.evidence) THEN
        RAISE EXCEPTION 'A machine green carries a citation that resolves — an admitted document of this workspace, an accepted turnover item or a human-completed MI checklist of this project; nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- applyAssessment: applicability, its rationale, and the status that
      -- follows (N/A with applicability N/A; N/A back to open with applies);
      -- never an N/A on an item that is satisfied or carries evidence (QUAL-5).
      IF NOT v_changed <@ ARRAY['applicability', 'ai_rationale', 'status', 'updated_at', 'updated_by', 'updated_by_name']
         OR (NEW.status IS DISTINCT FROM OLD.status
             AND NOT ((NEW.status = 'na' AND NEW.applicability = 'na')
                      OR (OLD.status = 'na' AND NEW.status = 'open' AND NEW.applicability = 'applies')))
         OR (NEW.applicability = 'na'
             AND (OLD.status = 'satisfied'
                  OR jsonb_array_length(checklist_evidence(OLD.evidence)) > 0)) THEN
        RAISE EXCEPTION 'The AI assessment changes only an item''s applicability, its rationale and the status that follows — never an N/A on a satisfied or evidence-bearing item; nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- (d) Every other signed-in write is a PERSON's: the row names the caller,
  --     and the machine's citations stay the machine's.
  NEW.updated_by := auth.uid();
  NEW.updated_by_name := quality_actor_name(auth.uid());
  IF checklist_chips(NEW.evidence, true)
     IS DISTINCT FROM checklist_chips(CASE WHEN TG_OP = 'UPDATE' THEN OLD.evidence END, true) THEN
    RAISE EXCEPTION 'A person''s write leaves the evidence sweep''s citations as they are — attach your own evidence instead; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_note_changed := CASE WHEN TG_OP = 'INSERT' THEN quality_reason_key(NEW.manual_note) IS NOT NULL
                         ELSE quality_reason_key(NEW.manual_note) IS DISTINCT FROM quality_reason_key(OLD.manual_note) END;
  v_decides := CASE WHEN TG_OP = 'INSERT' THEN NEW.status <> 'open' OR NEW.applicability = 'na'
                    ELSE NEW.status IS DISTINCT FROM OLD.status OR NEW.applicability IS DISTINCT FROM OLD.applicability END;
  -- A decision (satisfied, N/A, reopen) needs its OWN reason — the note on
  -- the row belongs to the earlier decision.
  IF v_decides AND NOT v_note_changed THEN
    RAISE EXCEPTION 'A decision on a checklist item needs its own reason of at least 10 characters — the note already on the item belongs to the earlier decision; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A note is a reason on the record: set or replaced only with one that
  -- meets the bar, never cleared.
  IF v_note_changed AND NOT quality_reason_ok(NEW.manual_note) THEN
    RAISE EXCEPTION 'A note on a checklist item is a reason on the record — at least 10 characters, not a canned string, and it cannot be cleared; nothing was changed.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION checklist_items_decision_rail() IS
  'SAF-4 / QUAL-2 / QUAL-6: no single-item delete or move; every item write SHARE-locks its checklist row; a completed checklist''s items are frozen; updated_by NULL is the machine actor, bounded to the sweep''s or the assessment''s own columns and transitions (a sweep green''s citation must resolve); every other signed-in write is stamped with the caller, leaves the machine''s citations alone, and a decision needs its own reason that meets quality_reason_ok.';

DROP TRIGGER IF EXISTS trg_checklist_items_decision_rail ON checklist_items;
CREATE TRIGGER trg_checklist_items_decision_rail
  BEFORE INSERT OR UPDATE OR DELETE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION checklist_items_decision_rail();

-- ── 5. QUAL-2: the completion gate, and the basis the database records ──────
CREATE OR REPLACE FUNCTION project_checklists_completion_basis_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_blocking integer;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- service pass: restores, server routes, the SQL editor
  IF NEW.status = 'complete' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'complete' THEN
      -- A completion keeps what it is: its kind (a QA/QC completion never
      -- becomes a citable MI one) and its project.
      IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        RAISE EXCEPTION 'A completed checklist keeps its kind and its project — reopen it first; nothing was changed.'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.completed_basis := OLD.completed_basis;   -- a completion's basis is never rewritten in place (its items are frozen)
    ELSE
      -- The gate setChecklistStatus applies: items exist, and every
      -- applicable item is satisfied or N/A.
      IF NOT EXISTS (SELECT 1 FROM checklist_items i WHERE i.checklist_id = NEW.id) THEN
        RAISE EXCEPTION 'This checklist has no items — nothing was verified, so it cannot be completed.'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT COUNT(*) INTO v_blocking FROM checklist_items i
       WHERE i.checklist_id = NEW.id
         AND i.applicability <> 'na' AND i.status NOT IN ('satisfied', 'na');
      IF v_blocking > 0 THEN
        RAISE EXCEPTION '% item(s) not satisfied yet — a checklist only completes when every applicable item is green or N/A.', v_blocking
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.completed_basis := checklist_completion_basis(NEW.id);
    END IF;
  ELSE
    NEW.completed_basis := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION project_checklists_completion_basis_rail() IS
  'QUAL-2: refuses a move to complete while the checklist has no items or an applicable item is neither satisfied nor N/A, and a change of kind or project while complete; completed_basis is computed by checklist_completion_basis() when a checklist moves to complete, kept while it stays complete, NULL otherwise — a client-supplied value is ignored.';

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
SELECT 'turnover_review_events.item_id carries no foreign key — the history outlives a deleted item (no cascade)',
       (SELECT COUNT(*) = 0 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE c.relname = 'turnover_review_events' AND k.contype = 'f'
           AND k.confrelid = 'public.turnover_items'::regclass),
       NULL
UNION ALL
SELECT 'the history writer fires AFTER INSERT OR UPDATE OF status on turnover_items, records the note only when this write changed it, and the reviewer''s sign-in name',
       (SELECT COUNT(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE c.relname = 'turnover_items' AND t.tgname = 'trg_turnover_items_review_event' AND NOT t.tgisinternal
           AND pg_get_triggerdef(t.oid) LIKE '%AFTER INSERT OR UPDATE OF status ON %turnover_items%'
           AND f.prosrc LIKE '%quality_reason_key(NEW.review_note) IS DISTINCT FROM quality_reason_key(OLD.review_note)%'
           AND f.prosrc NOT LIKE '%NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at%'
           AND f.prosrc LIKE '%quality_actor_name(auth.uid())%'),
       NULL
UNION ALL
SELECT 'quality_actor_name reads the sign-in email in auth.users (not the self-editable users profile), and no client may call it',
       (SELECT p.prosrc LIKE '%FROM auth.users u WHERE u.id = p_uid%' AND p.prosrc NOT LIKE '%FROM users u%'
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.proname = 'quality_actor_name'),
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
           AND NOT quality_reason_ok('x')
           AND NOT quality_reason_ok('   ')
           AND NOT quality_reason_ok(NULL)
           AND NOT quality_reason_ok(repeat(chr(160), 10))
           AND NOT quality_reason_ok(repeat(chr(8203), 12))
           AND NOT quality_reason_ok('decided' || chr(160) || 'by reviewer')
           AND quality_reason_key('  Reviewed page by page ') = quality_reason_key('reviewed page by page')),
       NULL
UNION ALL
SELECT 'the reason rails are live: turnover_items (waive / reject / reopen, a standing decision and its document), punch_items (void, a standing closure), checklist_items (every write, and delete)',
       (SELECT COUNT(*) = 3 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal
           AND ((c.relname = 'turnover_items' AND t.tgname = 'trg_turnover_items_decision_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status, review_note, reviewed_by, reviewed_by_name, reviewed_at, document_id ON %')
             OR (c.relname = 'punch_items' AND t.tgname = 'trg_punch_items_void_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF status, closure_note, closed_by, closed_by_name, closed_at ON %')
             OR (c.relname = 'checklist_items' AND t.tgname = 'trg_checklist_items_decision_rail'
                 AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR DELETE OR UPDATE ON %'))),
       NULL
UNION ALL
SELECT 'each reason rail demands its OWN reason (the note must change) that passes quality_reason_ok, and lets only the service pass through',
       (SELECT COUNT(*) = 3 FROM pg_proc p
         WHERE p.prosrc LIKE '%IF auth.uid() IS NULL THEN%'
           AND ((p.proname = 'turnover_items_decision_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.review_note)%'
                 AND p.prosrc LIKE '%quality_reason_key(NEW.review_note) IS NOT DISTINCT FROM quality_reason_key(OLD.review_note)%')
             OR (p.proname = 'punch_items_void_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.closure_note)%'
                 AND p.prosrc LIKE '%quality_reason_key(NEW.closure_note) IS NOT DISTINCT FROM quality_reason_key(OLD.closure_note)%')
             OR (p.proname = 'checklist_items_decision_rail' AND p.prosrc LIKE '%quality_reason_ok(NEW.manual_note)%'
                 AND p.prosrc LIKE '%IF v_decides AND NOT v_note_changed THEN%'))),
       NULL
UNION ALL
SELECT 'the machine actor (updated_by NULL) is bounded: a sentinel name, never a person''s item, no note, no person chip, each machine''s own columns only, a sweep green''s citation resolves — and a person''s write is stamped with the caller and leaves the machine''s citations alone',
       (SELECT p.prosrc LIKE '%NEW.updated_by_name NOT IN (''evidence sweep'', ''AI assessment'')%'
           AND p.prosrc LIKE '%quality_reason_key(OLD.manual_note) IS NOT NULL OR checklist_chips(OLD.evidence, false)%'
           AND p.prosrc LIKE '%checklist_chips(NEW.evidence, false) IS DISTINCT FROM checklist_chips(OLD.evidence, false)%'
           AND p.prosrc LIKE '%v_changed <@ ARRAY[''status'', ''evidence'', ''updated_at'', ''updated_by'', ''updated_by_name'']%'
           AND p.prosrc LIKE '%v_changed <@ ARRAY[''applicability'', ''ai_rationale'', ''status'', ''updated_at'', ''updated_by'', ''updated_by_name'']%'
           AND p.prosrc LIKE '%NOT checklist_auto_citation_ok(NEW.checklist_id, NEW.org_id, NEW.evidence)%'
           AND p.prosrc LIKE '%NEW.updated_by := auth.uid()%'
           AND p.prosrc LIKE '%checklist_chips(NEW.evidence, true)%'
          FROM pg_proc p WHERE p.proname = 'checklist_items_decision_rail'),
       NULL
UNION ALL
SELECT 'an item write SHARE-locks its checklist row (waiting at most 500 ms) before reading its status, and a signed-in single-item DELETE or move is refused, a cascade passes',
       (SELECT p.prosrc LIKE '%PERFORM 1 FROM project_checklists c WHERE c.id = NEW.checklist_id FOR SHARE%'
           AND position('set_config(''lock_timeout'', ''500ms'', true)' IN p.prosrc) BETWEEN 1 AND position('FOR SHARE' IN p.prosrc)
           AND position('FOR SHARE' IN p.prosrc) < position('INTO v_frozen' IN p.prosrc)
           AND p.prosrc LIKE '%IF pg_trigger_depth() > 1 THEN RETURN OLD%'
           AND p.prosrc LIKE '%NEW.checklist_id IS DISTINCT FROM OLD.checklist_id%'
          FROM pg_proc p WHERE p.proname = 'checklist_items_decision_rail'),
       NULL
UNION ALL
SELECT 'checklist_auto_citation_ok resolves a sweep citation to an admitted document (no provenance included), an accepted turnover item or a human MI completion — every branch in the item''s org',
       (SELECT p.prosrc LIKE '%d.status IN (''Issued'', ''Locked'')%'
           AND p.prosrc LIKE '%v.provenance IS NOT DISTINCT FROM ''external''%'
           AND p.prosrc NOT LIKE '%v.provenance = ''external''%'
           AND p.prosrc LIKE '%d.org_id = p_org_id%'
           AND p.prosrc LIKE '%t.org_id = p_org_id%'
           AND p.prosrc LIKE '%m.org_id = p_org_id%'
           AND p.prosrc LIKE '%t.status = ''accepted''%'
           AND p.prosrc LIKE '%m.completed_basis = ''human''%'
          FROM pg_proc p WHERE p.proname = 'checklist_auto_citation_ok'),
       NULL
UNION ALL
SELECT 'a legacy evidence value stored as one object reads as a single chip (checklist_evidence)',
       (SELECT checklist_evidence('{"source": "manual", "label": "x"}'::jsonb) = '[{"source": "manual", "label": "x"}]'::jsonb
           AND checklist_evidence('"a string"'::jsonb) = '[]'::jsonb
           AND checklist_evidence(NULL) = '[]'::jsonb
           AND checklist_chips('{"source": "manual", "label": "x"}'::jsonb, false) @> '[{"source": "manual"}]'::jsonb),
       NULL
UNION ALL
SELECT 'the checklist_items_na_rail of an earlier draft is gone (replaced by the decision rail)',
       (SELECT COUNT(*) = 0 FROM pg_proc WHERE proname = 'checklist_items_na_rail'),
       NULL
UNION ALL
SELECT 'the five trigger functions of §3–§5 are SECURITY DEFINER with search_path pinned to public',
       (SELECT COUNT(*) = 5 FROM pg_proc p
         WHERE p.proname IN ('turnover_items_record_review_event', 'turnover_items_decision_rail', 'punch_items_void_rail',
                             'checklist_items_decision_rail', 'project_checklists_completion_basis_rail')
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
SELECT 'checklist_completion_basis: a checklist with no green a person decided is auto (probed on an id with no items), and only a note that meets the bar counts — a person chip alone does not',
       (SELECT checklist_completion_basis(gen_random_uuid()) = 'auto'
           AND (SELECT p.prosrc LIKE '%AND NOT quality_reason_ok(i.manual_note)%' AND p.prosrc LIKE '%i.status NOT IN (''satisfied'', ''na'')%'
                       AND p.prosrc NOT LIKE '%''manual''%'
                  FROM pg_proc p WHERE p.proname = 'checklist_completion_basis')),
       NULL
UNION ALL
SELECT 'the completion rail is live on project_checklists (BEFORE INSERT OR UPDATE): it refuses an empty or unfinished checklist, keeps a completion''s kind and project, and ignores a client basis',
       (SELECT COUNT(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_proc f ON f.oid = t.tgfoid
         WHERE c.relname = 'project_checklists' AND t.tgname = 'trg_project_checklists_completion_basis' AND NOT t.tgisinternal
           AND f.prosrc LIKE '%NEW.completed_basis := checklist_completion_basis(NEW.id)%'
           AND f.prosrc LIKE '%NEW.completed_basis := OLD.completed_basis%'
           AND f.prosrc LIKE '%NEW.completed_basis := NULL%'
           AND f.prosrc LIKE '%IF v_blocking > 0 THEN%'
           AND f.prosrc LIKE '%IF NOT EXISTS (SELECT 1 FROM checklist_items i WHERE i.checklist_id = NEW.id) THEN%'
           AND f.prosrc LIKE '%NEW.kind IS DISTINCT FROM OLD.kind OR NEW.project_id IS DISTINCT FROM OLD.project_id%'),
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
