-- ─────────────────────────────────────────────────────────────────────────────
-- 20261250_df_roundG_review_model.sql
--
-- drafting-flow Round G — DF-P6 REVIEW-MODEL: what makes engineering review
-- required (DEC-33), the like-in-kind declaration that is the one thing that
-- removes it (DEC-34), the assigner's binding flag (GAP-111), and the
-- workspace's own work / code classes (GAP-101, TIER-4 — DEC-35: the names
-- are the facility's data, never a literal here).
--
--   (1) tickets gains, all nullable or defaulted, nothing renamed:
--         like_in_kind_statement / _declared_by / _declared_at /
--         _signature_id  the requester's typed declaration and the
--                        e-signature that is its record (no FK: e_signatures
--                        is never imported by a restore — as
--                        ticket_review_slots.signature_id, 20261242). Set by
--                        the create route at INSERT only; all four or none
--                        (CHECK); the statement at least 20 characters
--                        (CHECK).
--         engineering_required BOOLEAN NOT NULL DEFAULT true — every request
--                        filed from this paste on is engineered work unless
--                        its requester declared it like-in-kind (the create
--                        route writes false only with a declaration).
--         work_class / code_class TEXT — set by triage from the workspace's
--                        own lists (org_configurations 'drafting'
--                        workClasses / codeClasses, seeded EMPTY).
--         review_model_filed BOOLEAN NOT NULL — false on every row that
--                        exists before this paste, true on every row filed
--                        after it (added DEFAULT false, then SET DEFAULT
--                        true — the engineering_required pattern); never
--                        changed (ticket_update_guard, every caller). DEC-33's
--                        limbs that bind the REQUESTER (the requester's
--                        recorded override with its required comment, the
--                        engineer-pick question) apply only where it is true,
--                        so a pre-paste row the backfill (2) or a later flag
--                        sets engineering_required true keeps every requester
--                        path it has today (DF-P6 fix pass 2, review issue 1;
--                        lib/reviewModel.ts reviewModelBinds).
--   (2) THE BACKFILL (DEC-90 ruling (2) for DF-P6 — fail-safe, no flag day):
--       the column is ADDED with DEFAULT false, so every row that exists
--       before the paste starts false, and only then is the default moved to
--       true for the rows filed after it. A pre-paste row is then set true
--       exactly where the LEGACY gate (engineerApprovalRequired — the DEC-16
--       snapshot OR current test against ticket.engineer_gate_exempt, DEC-13
--       stage 3) is CERTAIN to require an engineer: no role stamped at
--       filing, a requester who is no longer an active member, or — in a
--       workspace that stores no engineer_gate_exempt list and grants it to
--       nobody, i.e. the shipped default decides — a requester whose stamped
--       role or whose current roles hold none of Admin, Manager, Supervisor,
--       DocCtrl or an Engineer tier. Every other pre-paste row stays false
--       WITHOUT a declaration, which the app reads as "the legacy gate
--       decides" (lib/reviewModel.ts ticketEngineeringRequired — the SEED,
--       evaluated live as today), so no in-flight request changes lane: a
--       row set true here is one the legacy gate requires an engineer for
--       today, and a row left false is gated by the legacy gate exactly as
--       today (a requester demoted after filing still routes to an engineer —
--       DEC-16). The only difference: a row set true stays required if its
--       requester is later promoted (fail-safe). Every pre-paste row carries
--       review_model_filed false, so whatever engineering_required says its
--       requester keeps today's paths (the requester-binding limbs of DEC-33
--       never apply to it).
--   (3) ticket_update_guard RE-CREATED FROM ITS NEWEST BODY (20261221 —
--       found by scanning; lineDiff-pinned by
--       lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts). Every line of
--       the base is kept (the issued-Rev and revisionRound limbs, the history
--       trust index, library_id, outcome, the departure pass, the
--       last_modified rule). Added:
--         (a) for EVERY caller, the service role included (ahead of its early
--             return): the four declaration columns and review_model_filed
--             never change after INSERT, and engineering_required never goes
--             true → false;
--         (b) for a client: engineering_required, work_class and code_class
--             are workflow-owned.
--   (4) ticket_review_model_insert_guard() (new; SECURITY INVOKER, search_path
--       pinned) + trg_ticket_review_model_insert_guard BEFORE INSERT: a row a
--       signed-in client inserts (no app path does — 20261208 dropped the
--       client INSERT policy; this holds if a re-paste ever brings it back)
--       is born engineered, undeclared, unclassified and filed under the
--       review model. The create route
--       (service role) is the one writer of a declaration.
--
-- PASTE / DEPLOY ORDER: DEPLOY THE DF-P6 APP FIRST, THEN PASTE THIS FILE.
-- Paste AFTER 20261221 (the first statement refuses otherwise, changing
-- nothing).
--   * Between the deploy and this paste the columns are not there — a
--     ticket read carries no engineering_required (the engine's seed
--     decides: the role-based gate, today's), a declaration's insert answers
--     42703 / PGRST204 and the request is filed the usual way with a warning
--     that the declaration was not recorded, and a work / code class is not
--     recorded (warning). Nothing that works today stops working.
--   * Do NOT paste before the deploy. The app before DF-P6 offers no
--     declaration, so every request it files after this paste lands with
--     review_model_filed true and engineering_required true. When the DF-P6
--     app then deploys, such a request filed in that window by a requester
--     the legacy gate exempts (a Manager, say) changes lane in flight: it
--     needs an engineer, or a recorded management override with the
--     requester's comment. If the paste did go first, deploy at once; the
--     window's requests can be listed by created_at between the paste and
--     the deploy.
-- Never re-paste 20261221, 20261208, 20261195, 20261166 or 20261038 after
-- this file (each puts back a guard without the ratchet and the declaration
-- limb). Every later re-creation of ticket_update_guard starts from THIS
-- file's body (lib/__tests__/dfRoundG_P6_reviewModelMigration.test.ts scans
-- the folder and refuses a newest body without the limbs).
--
-- Not a widening (it narrows: nobody may clear a declaration or lower the
-- requirement; a client may write none of the new columns). The backfill
-- only ever writes true onto a row the legacy gate already requires an
-- engineer for. Re-runnable: ADD COLUMN IF NOT EXISTS, each CHECK added once,
-- functions CREATE OR REPLACE, triggers DROP-then-CREATE; the backfill touches
-- only undeclared rows still false, and sets true only where the legacy gate
-- is certain.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ticket_update_guard'
                  AND prosrc LIKE '%issued Rev [[:digit:]]%'
                  AND prosrc LIKE '%history_guarded_from%') THEN
    RAISE EXCEPTION '20261250 needs 20261221 (the DF-P12 issue-line rails) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- "Certain under the legacy gate" is the backfill's own predicate, spelled
-- out here because the column does not exist yet (the test pins the two
-- spellings to each other).
DROP TABLE IF EXISTS df_round_g_250_before;
CREATE TEMP TABLE df_round_g_250_before AS
WITH legacy AS (
  SELECT t.status,
         (
           t.requester_role IS NULL
           OR t.requester_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.requester_id AND m.status = 'active')
           OR (
             NOT EXISTS (SELECT 1 FROM org_configurations c
                          WHERE c.org_id = t.org_id AND c.key = 'capability_policy'
                            AND COALESCE(c.data->'caps'->'ticket.engineer_gate_exempt', c.data->'ticket.engineer_gate_exempt') IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM org_configurations c,
                                    jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g(e)
                              WHERE c.org_id = t.org_id AND c.key = 'capability_policy'
                                AND g.e->>'cap' = 'ticket.engineer_gate_exempt' AND g.e->>'uid' = t.requester_id::text)
             AND (
               NOT (t.requester_role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR t.requester_role LIKE '%Engineer%')
               OR NOT EXISTS (SELECT 1 FROM org_members m
                               WHERE m.org_id = t.org_id AND m.uid = t.requester_id AND m.status = 'active'
                                 AND (m.role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR m.role LIKE '%Engineer%'
                                      OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.roles, '{}'::text[])) r(x)
                                                  WHERE r.x IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR r.x LIKE '%Engineer%')))
             )
           )
         ) AS certain
    FROM tickets t
   WHERE t.archived_at IS NULL AND t.status NOT IN ('CLOSED', 'CANCELED')
)
SELECT 1 AS ord, 'inventory (before apply): open tickets (not closed, canceled or archived)' AS inventory, COUNT(*)::text AS n FROM legacy
UNION ALL
SELECT 2, 'inventory (before apply): open tickets the legacy gate is CERTAIN to require an engineer for (set engineering_required = true — no change of lane)', COUNT(*) FILTER (WHERE certain)::text FROM legacy
UNION ALL
SELECT 3, 'inventory (before apply): open tickets left to the legacy gate, evaluated live as today (engineering_required false, no declaration)', COUNT(*) FILTER (WHERE NOT certain)::text FROM legacy
UNION ALL
SELECT 10 + row_number() OVER (ORDER BY status), 'inventory (before apply): open at ' || status || ' — certain / left to the legacy gate',
       (COUNT(*) FILTER (WHERE certain))::text || ' / ' || (COUNT(*) FILTER (WHERE NOT certain))::text
  FROM legacy GROUP BY status
UNION ALL
SELECT 40, 'inventory (before apply): workspaces storing their own engineer_gate_exempt list or granting it (their rows are left to the legacy gate)',
       COUNT(*)::text
  FROM org_configurations c
 WHERE c.key = 'capability_policy'
   AND (COALESCE(c.data->'caps'->'ticket.engineer_gate_exempt', c.data->'ticket.engineer_gate_exempt') IS NOT NULL
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g(e)
                    WHERE g.e->>'cap' = 'ticket.engineer_gate_exempt'))
UNION ALL
SELECT 41, 'inventory (before apply): GAP-105 — stored rules on a ticket.* capability scoped to a library (they never match: the request does not present its library; a stored one rides along with every later save, grant and revoke, and only a NEW one is refused; expected 0)',
       COUNT(*)::text
  FROM org_configurations c,
       jsonb_each(CASE WHEN jsonb_typeof(c.data->'caps') = 'object' THEN c.data->'caps' ELSE '{}'::jsonb END) cap(k, v),
       jsonb_array_elements(CASE WHEN jsonb_typeof(cap.v) = 'array' THEN cap.v ELSE '[]'::jsonb END) rule(e)
 WHERE c.key = 'capability_policy' AND cap.k LIKE 'ticket.%'
   AND jsonb_typeof(rule.e) = 'object'
   AND jsonb_typeof(rule.e->'when'->'libraryId') = 'array' AND jsonb_array_length(rule.e->'when'->'libraryId') > 0
UNION ALL
SELECT 42, 'inventory (before apply): GAP-105 — tickets carrying a library in workspaces with such a library-scoped ticket.* rule (the rule does not reach them)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.library_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM org_configurations c,
                      jsonb_each(CASE WHEN jsonb_typeof(c.data->'caps') = 'object' THEN c.data->'caps' ELSE '{}'::jsonb END) cap(k, v),
                      jsonb_array_elements(CASE WHEN jsonb_typeof(cap.v) = 'array' THEN cap.v ELSE '[]'::jsonb END) rule(e)
                WHERE c.org_id = t.org_id AND c.key = 'capability_policy' AND cap.k LIKE 'ticket.%'
                  AND jsonb_typeof(rule.e) = 'object'
                  AND jsonb_typeof(rule.e->'when'->'libraryId') = 'array' AND jsonb_array_length(rule.e->'when'->'libraryId') > 0)
UNION ALL
SELECT 43, 'inventory (before apply): GAP-110 acceptance 5 — tickets whose metadata carries the check-in''s minor_correction / undocumented_change marks (informational records; nothing reads them for authority)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.metadata ? 'minor_correction' OR t.metadata ? 'undocumented_change';

BEGIN;

-- ── 1. the columns ─────────────────────────────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS like_in_kind_statement TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS like_in_kind_declared_by UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS like_in_kind_declared_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS like_in_kind_signature_id UUID;
-- Added with DEFAULT false: every row that exists now starts false (no
-- trigger runs for an added column); the default moves to true right after,
-- so every row filed from here on is engineered work unless declared.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineering_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tickets ALTER COLUMN engineering_required SET DEFAULT true;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS work_class TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS code_class TEXT;
-- The same pattern: every row that exists now was filed before the review
-- model (false); every row filed from here on, under it (true).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS review_model_filed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tickets ALTER COLUMN review_model_filed SET DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_like_in_kind_all_or_none' AND conrelid = 'public.tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_like_in_kind_all_or_none CHECK (
      (like_in_kind_statement IS NULL AND like_in_kind_declared_by IS NULL AND like_in_kind_declared_at IS NULL AND like_in_kind_signature_id IS NULL)
      OR (like_in_kind_statement IS NOT NULL AND like_in_kind_declared_by IS NOT NULL AND like_in_kind_declared_at IS NOT NULL AND like_in_kind_signature_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_like_in_kind_statement_length' AND conrelid = 'public.tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_like_in_kind_statement_length CHECK (
      like_in_kind_statement IS NULL OR char_length(btrim(like_in_kind_statement)) BETWEEN 20 AND 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_review_class_length' AND conrelid = 'public.tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_review_class_length CHECK (
      (work_class IS NULL OR char_length(work_class) BETWEEN 1 AND 120)
      AND (code_class IS NULL OR char_length(code_class) BETWEEN 1 AND 120));
  END IF;
END
$$;
COMMENT ON COLUMN tickets.engineering_required IS
  'drafting-flow GAP-111 / DEC-33 (20261250): engineering review is required before the request may issue. True unless the requester declared the work like-in-kind at filing; raised (never lowered — ticket_update_guard refuses true → false for every caller) by request_eng_review, the assigner''s flag or an engineering class. A pre-20261250 row left false WITHOUT a declaration is gated by the legacy role-based gate (the app''s seed).';
COMMENT ON COLUMN tickets.review_model_filed IS
  'drafting-flow DEC-33 (20261250, DF-P6 fix pass 2): the request was filed under the review model — false on every row that existed before 20261250, true on every row filed after it; never changed (ticket_update_guard). The requirement''s limbs that bind the requester apply only where it is true; a pre-20261250 row keeps the requester paths it had (DEC-90 ruling (2)).';
COMMENT ON COLUMN tickets.like_in_kind_statement IS
  'drafting-flow GAP-110 / DEC-34 (20261250): the requester''s like-in-kind declaration as they typed it; with _declared_by / _declared_at / _signature_id (the e-signature that is its record). Set at filing only; immutable.';

-- ── 2. the backfill — the legacy gate's CERTAIN answer, never more ──────────
-- The same predicate as the inventory above (pinned by the shape test).
UPDATE tickets t SET engineering_required = true
 WHERE NOT t.engineering_required
   AND t.like_in_kind_declared_at IS NULL
   AND (
     t.requester_role IS NULL
     OR t.requester_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.requester_id AND m.status = 'active')
     OR (
       NOT EXISTS (SELECT 1 FROM org_configurations c
                    WHERE c.org_id = t.org_id AND c.key = 'capability_policy'
                      AND COALESCE(c.data->'caps'->'ticket.engineer_gate_exempt', c.data->'ticket.engineer_gate_exempt') IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM org_configurations c,
                              jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'grants') = 'array' THEN c.data->'grants' ELSE '[]'::jsonb END) g(e)
                        WHERE c.org_id = t.org_id AND c.key = 'capability_policy'
                          AND g.e->>'cap' = 'ticket.engineer_gate_exempt' AND g.e->>'uid' = t.requester_id::text)
       AND (
         NOT (t.requester_role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR t.requester_role LIKE '%Engineer%')
         OR NOT EXISTS (SELECT 1 FROM org_members m
                         WHERE m.org_id = t.org_id AND m.uid = t.requester_id AND m.status = 'active'
                           AND (m.role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR m.role LIKE '%Engineer%'
                                OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.roles, '{}'::text[])) r(x)
                                            WHERE r.x IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl') OR r.x LIKE '%Engineer%')))
       )
     )
   );

-- ── 3. ticket_update_guard — re-created from 20261221 (lineDiff-pinned) ─────
CREATE OR REPLACE FUNCTION ticket_update_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad TEXT[] := '{}';
  v_old_len INT;
  v_email TEXT;
  v_entry JSONB;
  v_guarded_from_in INT := NEW.history_guarded_from;
BEGIN
  -- DF-P12 (drafting-flow SM-5 / EDGE-2, 20261221): history_guarded_from is
  -- the index in history from which every "issued Rev N" entry is the
  -- workflow's own. From this paste a client cannot append one (refused
  -- below), so every entry from the row's history length at its first
  -- write after the paste onward was written by the service role (or the
  -- paste owner). Stamped here, ahead of every early return. An archived
  -- stub's history is in its archive bundle: the shed (live → archived)
  -- clears the index and a write that leaves the row archived stamps
  -- nothing. The restore (archived → live) re-stamps it at the full
  -- restored length, whatever the row carried: it writes history from an
  -- admin-uploaded bundle this trigger never saw (only the attachment bytes
  -- are checked against the bundle's manifest), so nothing restored is
  -- proven. A non-array history counts as empty.
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    NEW.history_guarded_from := CASE WHEN jsonb_typeof(NEW.history) = 'array' THEN jsonb_array_length(NEW.history) ELSE 0 END;
  ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    NEW.history_guarded_from := NULL;
  ELSIF OLD.archived_at IS NULL AND OLD.history_guarded_from IS NULL AND NEW.history_guarded_from IS NULL THEN
    NEW.history_guarded_from := CASE WHEN jsonb_typeof(OLD.history) = 'array' THEN jsonb_array_length(OLD.history) ELSE 0 END;
  END IF;

  -- DF-P6 (drafting-flow GAP-110 / GAP-111 / DEC-33 / DEC-34, 20261250):
  -- held for EVERY caller — the service role and the paste owner included,
  -- so ahead of the service-role return below. The like-in-kind declaration
  -- is written once, by the create route at INSERT, and never changed by
  -- anyone; engineering_required is a ratchet that only turns true-ward.
  IF NEW.like_in_kind_statement    IS DISTINCT FROM OLD.like_in_kind_statement
     OR NEW.like_in_kind_declared_by  IS DISTINCT FROM OLD.like_in_kind_declared_by
     OR NEW.like_in_kind_declared_at  IS DISTINCT FROM OLD.like_in_kind_declared_at
     OR NEW.like_in_kind_signature_id IS DISTINCT FROM OLD.like_in_kind_signature_id THEN
    RAISE EXCEPTION 'tickets: the like-in-kind declaration is set when the request is filed and cannot be changed';
  END IF;
  IF OLD.engineering_required AND NOT NEW.engineering_required THEN
    RAISE EXCEPTION 'tickets: engineering_required only ratchets up — it cannot be cleared';
  END IF;
  -- Whether the request was filed under the review model is a fact of its
  -- filing (DF-P6 fix pass 2): nobody changes it.
  IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN
    RAISE EXCEPTION 'tickets: review_model_filed is set when the request is filed and cannot be changed';
  END IF;

  -- The workflow-action route (service role) is the transition authority.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- DF-P3 (drafting-flow EDGE-4): the member-departure path. When a member
  -- is suspended or removed, return_departed_member_tickets() (run by the
  -- org_members departure triggers, as the definer, inside the removing
  -- Admin's session) hands their in-flight tickets back to the queue. It marks
  -- its own transaction with the departing uid (set_config(..., true), which
  -- the API cannot reach), and only a row that member held, written from
  -- inside a trigger, passes on the mark.
  IF pg_trigger_depth() > 1
     AND COALESCE(current_setting('app.ticket_departure', true), '') <> ''
     AND current_setting('app.ticket_departure', true) IN (OLD.assigned_drafter_id::text, OLD.assigned_engineer_id::text) THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id                      IS DISTINCT FROM OLD.org_id                      THEN v_bad := array_append(v_bad, 'org_id'); END IF;
  IF NEW.ticket_id                   IS DISTINCT FROM OLD.ticket_id                   THEN v_bad := array_append(v_bad, 'ticket_id'); END IF;
  IF NEW.status                      IS DISTINCT FROM OLD.status                      THEN v_bad := array_append(v_bad, 'status'); END IF;
  IF NEW.requester_id                IS DISTINCT FROM OLD.requester_id                THEN v_bad := array_append(v_bad, 'requester_id'); END IF;
  IF NEW.requester_role              IS DISTINCT FROM OLD.requester_role              THEN v_bad := array_append(v_bad, 'requester_role'); END IF;
  IF NEW.requester_name              IS DISTINCT FROM OLD.requester_name              THEN v_bad := array_append(v_bad, 'requester_name'); END IF;
  IF NEW.requester_email             IS DISTINCT FROM OLD.requester_email             THEN v_bad := array_append(v_bad, 'requester_email'); END IF;
  IF NEW.assigned_drafter_id         IS DISTINCT FROM OLD.assigned_drafter_id         THEN v_bad := array_append(v_bad, 'assigned_drafter_id'); END IF;
  IF NEW.assigned_drafter_name       IS DISTINCT FROM OLD.assigned_drafter_name       THEN v_bad := array_append(v_bad, 'assigned_drafter_name'); END IF;
  IF NEW.assigned_engineer_id        IS DISTINCT FROM OLD.assigned_engineer_id        THEN v_bad := array_append(v_bad, 'assigned_engineer_id'); END IF;
  IF NEW.assigned_engineer_name      IS DISTINCT FROM OLD.assigned_engineer_name      THEN v_bad := array_append(v_bad, 'assigned_engineer_name'); END IF;
  IF NEW.assigned_engineer_email     IS DISTINCT FROM OLD.assigned_engineer_email     THEN v_bad := array_append(v_bad, 'assigned_engineer_email'); END IF;
  IF NEW.engineer_review_requested_at IS DISTINCT FROM OLD.engineer_review_requested_at THEN v_bad := array_append(v_bad, 'engineer_review_requested_at'); END IF;
  IF NEW.engineer_approved_at        IS DISTINCT FROM OLD.engineer_approved_at        THEN v_bad := array_append(v_bad, 'engineer_approved_at'); END IF;
  IF NEW.engineer_review_reason      IS DISTINCT FROM OLD.engineer_review_reason      THEN v_bad := array_append(v_bad, 'engineer_review_reason'); END IF;
  IF NEW.deliverable_rev             IS DISTINCT FROM OLD.deliverable_rev             THEN v_bad := array_append(v_bad, 'deliverable_rev'); END IF;
  IF NEW.draft_iteration             IS DISTINCT FROM OLD.draft_iteration             THEN v_bad := array_append(v_bad, 'draft_iteration'); END IF;
  IF NEW.revision_count              IS DISTINCT FROM OLD.revision_count              THEN v_bad := array_append(v_bad, 'revision_count'); END IF;
  IF NEW.closed_at                   IS DISTINCT FROM OLD.closed_at                   THEN v_bad := array_append(v_bad, 'closed_at'); END IF;
  IF NEW.archived_at                 IS DISTINCT FROM OLD.archived_at                 THEN v_bad := array_append(v_bad, 'archived_at'); END IF;
  IF NEW.archive_id                  IS DISTINCT FROM OLD.archive_id                  THEN v_bad := array_append(v_bad, 'archive_id'); END IF;
  IF NEW.created_at                  IS DISTINCT FROM OLD.created_at                  THEN v_bad := array_append(v_bad, 'created_at'); END IF;
  -- DF-P1 (drafting-flow SM-2's census, LEAK-10, LEAK-3, EVID-1, DCW-4 / HAND-3,
  -- SM-14): every other column the browser does not write is service-owned
  -- too — the row's key, the request's scope (title, description), the
  -- DEC-13 resource every scoped capability rule reads (request_type, unit),
  -- the arrays and the metadata bag the routes write compare-and-set, the
  -- search fields and the SLA clocks. A client keeps exactly four: priority
  -- (the queue's mark-urgent), last_modified (stamped, never cleared),
  -- unread_by (its own marker only) and history (append only, in its own
  -- name) — each decided below.
  IF NEW.id                          IS DISTINCT FROM OLD.id                          THEN v_bad := array_append(v_bad, 'id'); END IF;
  IF NEW.title                       IS DISTINCT FROM OLD.title                       THEN v_bad := array_append(v_bad, 'title'); END IF;
  IF NEW.description                 IS DISTINCT FROM OLD.description                 THEN v_bad := array_append(v_bad, 'description'); END IF;
  IF NEW.request_type                IS DISTINCT FROM OLD.request_type                THEN v_bad := array_append(v_bad, 'request_type'); END IF;
  IF NEW.unit                        IS DISTINCT FROM OLD.unit                        THEN v_bad := array_append(v_bad, 'unit'); END IF;
  IF NEW.attachments                 IS DISTINCT FROM OLD.attachments                 THEN v_bad := array_append(v_bad, 'attachments'); END IF;
  IF NEW.comments                    IS DISTINCT FROM OLD.comments                    THEN v_bad := array_append(v_bad, 'comments'); END IF;
  IF NEW.metadata                    IS DISTINCT FROM OLD.metadata                    THEN v_bad := array_append(v_bad, 'metadata'); END IF;
  IF NEW.watchers                    IS DISTINCT FROM OLD.watchers                    THEN v_bad := array_append(v_bad, 'watchers'); END IF;
  IF NEW.search_keywords             IS DISTINCT FROM OLD.search_keywords             THEN v_bad := array_append(v_bad, 'search_keywords'); END IF;
  IF NEW.search_tsv                  IS DISTINCT FROM OLD.search_tsv                  THEN v_bad := array_append(v_bad, 'search_tsv'); END IF;
  IF NEW.target_completion_at        IS DISTINCT FROM OLD.target_completion_at        THEN v_bad := array_append(v_bad, 'target_completion_at'); END IF;
  IF NEW.sla_breach_warned_at        IS DISTINCT FROM OLD.sla_breach_warned_at        THEN v_bad := array_append(v_bad, 'sla_breach_warned_at'); END IF;
  IF NEW.sla_breached_at             IS DISTINCT FROM OLD.sla_breached_at             THEN v_bad := array_append(v_bad, 'sla_breached_at'); END IF;
  IF NEW.updated_at                  IS DISTINCT FROM OLD.updated_at                  THEN v_bad := array_append(v_bad, 'updated_at'); END IF;
  -- DF-P3 (drafting-flow LEAK-9 / GAP-107): how a request ended is the
  -- workflow route's to record, with the close or the cancel.
  IF NEW.outcome                     IS DISTINCT FROM OLD.outcome                     THEN v_bad := array_append(v_bad, 'outcome'); END IF;
  -- DF-P4 (drafting-flow GAP-105 / DCW-1): the library a request targets is
  -- the workflow's — derived by the create route from the source document,
  -- set or corrected by triage (the workflow route), both as the service
  -- role. The one other writer is the library's own deletion: ON DELETE SET
  -- NULL clears it from inside the delete's trigger once the library row is
  -- gone, and only that passes.
  IF NEW.library_id IS DISTINCT FROM OLD.library_id
     AND NOT (pg_trigger_depth() > 1 AND NEW.library_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = OLD.library_id)) THEN
    v_bad := array_append(v_bad, 'library_id');
  END IF;
  -- DF-P6 (drafting-flow GAP-111 / GAP-101 / TIER-4, 20261250): the
  -- engineering requirement and the review classes are the workflow's —
  -- raised by request_eng_review, the assigner's flag or an engineering
  -- class, set by triage, all through the workflow route as the service role.
  IF NEW.engineering_required        IS DISTINCT FROM OLD.engineering_required        THEN v_bad := array_append(v_bad, 'engineering_required'); END IF;
  IF NEW.work_class                  IS DISTINCT FROM OLD.work_class                  THEN v_bad := array_append(v_bad, 'work_class'); END IF;
  IF NEW.code_class                  IS DISTINCT FROM OLD.code_class                  THEN v_bad := array_append(v_bad, 'code_class'); END IF;
  -- DF-P12 (drafting-flow SM-5 / EDGE-2, 20261221): the history trust index
  -- is stamped by this trigger (above) — never a client's to write.
  IF v_guarded_from_in IS DISTINCT FROM OLD.history_guarded_from THEN v_bad := array_append(v_bad, 'history_guarded_from'); END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION 'tickets: column(s) % are workflow-owned — use the request workflow actions', array_to_string(v_bad, ', ');
  END IF;

  -- WF-2: the history log only grows. (Append is a legitimate client write —
  -- file uploads and project links add entries — deletion is not.)
  IF jsonb_array_length(COALESCE(NEW.history, '[]'::jsonb))
     < jsonb_array_length(COALESCE(OLD.history, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'tickets: the history log cannot shrink';
  END IF;

  -- DF-P1 (EVID-1 / AUTHZ-2 / PERS-1): the entries already in the log are
  -- immutable — a client may only APPEND (no browser path writes history
  -- today; the dormant project-link push in lib/projects.ts appends), and an
  -- entry it appends names the caller, never somebody else.
  v_old_len := jsonb_array_length(COALESCE(OLD.history, '[]'::jsonb));
  IF COALESCE((SELECT jsonb_agg(h.value ORDER BY h.ordinality)
                 FROM jsonb_array_elements(COALESCE(NEW.history, '[]'::jsonb)) WITH ORDINALITY AS h
                WHERE h.ordinality <= v_old_len), '[]'::jsonb)
     IS DISTINCT FROM COALESCE(OLD.history, '[]'::jsonb) THEN
    RAISE EXCEPTION 'tickets: history entries cannot be changed — the log is append-only';
  END IF;
  IF jsonb_array_length(COALESCE(NEW.history, '[]'::jsonb)) > v_old_len THEN
    SELECT email INTO v_email FROM org_members
     WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;
    FOR v_entry IN SELECT h.value FROM jsonb_array_elements(NEW.history) WITH ORDINALITY AS h
                    WHERE h.ordinality > v_old_len LOOP
      IF (v_entry->>'user') IS DISTINCT FROM v_email
         AND (v_entry->>'user') IS DISTINCT FROM auth.uid()::text THEN
        RAISE EXCEPTION 'tickets: a history entry you add must name you';
      END IF;
      -- DF-P12 (drafting-flow SM-5 / EDGE-2 / PHYS-2, 20261221): an "issued
      -- Rev N" line is what the verify verdict, the copy stamp and the SM-5
      -- re-cycle read as an issue, so only the workflow writes one. Matched
      -- more widely than the readers' /\bissued Rev (\d+)\b/ (any case, any
      -- JSON shape of `action`), never more narrowly.
      IF COALESCE(v_entry->>'action', '') ~* 'issued Rev [[:digit:]]' THEN
        RAISE EXCEPTION 'tickets: an "issued Rev" history entry is written only by the request workflow';
      END IF;
      -- So is a revision round's marker: computeTransition records
      -- `revisionRound` on the entry of the round a request for revision, a
      -- reject or reject_final opens, and the verdict reads round N after a
      -- proven issue N as "the issued package was sent back" (DEC-44
      -- (DF-P12) item 2). Matched on the key in any JSON shape.
      IF v_entry ? 'revisionRound' THEN
        RAISE EXCEPTION 'tickets: a revision-round history entry is written only by the request workflow';
      END IF;
    END LOOP;
  END IF;

  -- DF-P1 (PERS-1 / LEAK-4): unread_by — a client clears only its OWN unread
  -- marker (the request page's mark-read). Whatever array a client writes,
  -- what lands is the stored array minus the caller: nobody else leaves it
  -- and nobody joins it. Never an error: the page sends the whole array it
  -- read moments earlier, and a reader who marked it read in between makes
  -- that array stale; refusing it would leave the caller's own marker in place.
  IF NEW.unread_by IS DISTINCT FROM OLD.unread_by THEN
    NEW.unread_by := array_remove(COALESCE(OLD.unread_by, '{}'::uuid[]), auth.uid());
  END IF;

  -- DF-P1 (EDGE-15): last_modified is the compare-and-set token. A client may
  -- stamp it (the queue's mark-urgent does) but never clear it — a NULL token
  -- reduced every later route write on the row to a status-only check.
  IF NEW.last_modified IS NULL AND OLD.last_modified IS NOT NULL THEN
    RAISE EXCEPTION 'tickets: last_modified cannot be cleared';
  END IF;

  RETURN NEW;
END;
$$;
-- CREATE OR REPLACE keeps the function trg_ticket_update_guard runs; the
-- trigger is restated so a database missing it gets it back.
DROP TRIGGER IF EXISTS trg_ticket_update_guard ON tickets;
CREATE TRIGGER trg_ticket_update_guard
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_update_guard();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. a client-inserted row is born engineered, undeclared, unclassified ──
-- New function (no earlier body). SECURITY INVOKER: it only resets fields of
-- the row being inserted and reads nothing.
CREATE OR REPLACE FUNCTION ticket_review_model_insert_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The create route (service role) is the one writer of a declaration.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  NEW.engineering_required := true;
  NEW.review_model_filed := true;
  NEW.like_in_kind_statement := NULL;
  NEW.like_in_kind_declared_by := NULL;
  NEW.like_in_kind_declared_at := NULL;
  NEW.like_in_kind_signature_id := NULL;
  NEW.work_class := NULL;
  NEW.code_class := NULL;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ticket_review_model_insert_guard ON tickets;
CREATE TRIGGER trg_ticket_review_model_insert_guard
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_review_model_insert_guard();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_review_model_insert_guard() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'GAP-110 / GAP-111 / GAP-101: tickets carries the declaration (statement, declared_by, declared_at, signature_id), engineering_required and review_model_filed (boolean, NOT NULL, DEFAULT true), work_class and code_class' AS check,
       ((SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tickets'
            AND column_name IN ('like_in_kind_statement', 'like_in_kind_declared_by', 'like_in_kind_declared_at', 'like_in_kind_signature_id', 'work_class', 'code_class')) = 6
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'engineering_required'
                       AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true')
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'review_model_filed'
                       AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the declaration is all-or-none, its statement 20 to 2000 characters; a class at most 120',
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = 'public.tickets'::regclass AND contype = 'c'
           AND conname IN ('tickets_like_in_kind_all_or_none', 'tickets_like_in_kind_statement_length', 'tickets_review_class_length')) = 3,
       NULL
UNION ALL
SELECT 'ticket_update_guard: the declaration and review_model_filed never change and engineering_required never clears (every caller, ahead of the service-role return); the new columns are workflow-owned; the issued-Rev / revisionRound limbs, the history trust index, library_id, outcome, the departure pass and the last_modified rule kept; SECURITY DEFINER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_update_guard' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_update_guard' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%IF OLD.engineering_required AND NOT NEW.engineering_required THEN%'
                  AND p.prosrc LIKE '%OR NEW.like_in_kind_signature_id IS DISTINCT FROM OLD.like_in_kind_signature_id THEN%'
                  AND p.prosrc LIKE '%IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN%'
                  AND position('IF NEW.review_model_filed IS DISTINCT FROM OLD.review_model_filed THEN' IN p.prosrc) < position('IF auth.uid() IS NULL THEN RETURN NEW; END IF;' IN p.prosrc)
                  AND position('IF OLD.engineering_required AND NOT NEW.engineering_required THEN' IN p.prosrc) < position('IF auth.uid() IS NULL THEN RETURN NEW; END IF;' IN p.prosrc)
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''engineering_required'');%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''work_class'');%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''code_class'');%'
                  AND p.prosrc LIKE '%IF COALESCE(v_entry->>''action'', '''') ~* ''issued Rev [[:digit:]]'' THEN%'
                  AND p.prosrc LIKE '%IF v_entry ? ''revisionRound'' THEN%'
                  AND p.prosrc LIKE '%NEW.history_guarded_from := CASE%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''history_guarded_from'');%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''library_id'');%'
                  AND p.prosrc LIKE '%array_append(v_bad, ''outcome''); END IF;%'
                  AND p.prosrc LIKE '%app.ticket_departure%'
                  AND p.prosrc LIKE '%tickets: last_modified cannot be cleared%'),
       NULL
UNION ALL
SELECT 'ticket_review_model_insert_guard: a client insert is born engineered, undeclared, unclassified and filed under the review model; SECURITY INVOKER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_review_model_insert_guard' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_review_model_insert_guard' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%NEW.engineering_required := true;%'
                  AND p.prosrc LIKE '%NEW.review_model_filed := true;%'
                  AND p.prosrc LIKE '%NEW.like_in_kind_statement := NULL;%'),
       NULL
UNION ALL
SELECT 'DRLS-16: neither trigger function is executable by anon or authenticated',
       NOT has_function_privilege('anon', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_review_model_insert_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_review_model_insert_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_250_before ORDER BY ord) b
UNION ALL
SELECT 'after: open tickets with engineering_required = true / false (false = declared like-in-kind, or left to the legacy gate)', NULL,
       (SELECT COUNT(*) FILTER (WHERE engineering_required)::text || ' / ' || COUNT(*) FILTER (WHERE NOT engineering_required)::text
          FROM tickets WHERE archived_at IS NULL AND status NOT IN ('CLOSED', 'CANCELED'))
UNION ALL
SELECT 'after: open tickets filed before the review model (review_model_filed false — the requester keeps today''s paths)', NULL,
       (SELECT COUNT(*) FILTER (WHERE NOT review_model_filed)::text
          FROM tickets WHERE archived_at IS NULL AND status NOT IN ('CLOSED', 'CANCELED'));
