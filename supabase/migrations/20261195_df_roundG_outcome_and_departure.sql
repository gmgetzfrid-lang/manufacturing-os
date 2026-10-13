-- ─────────────────────────────────────────────────────────────────────────────
-- 20261195_df_roundG_outcome_and_departure.sql
--
-- drafting-flow Round G — DF-P3 ROUTING: how a request ended, the revision
-- nobody drafts, and the member who leaves with work in hand.
--
--   (1) LEAK-9 / GAP-107: tickets.outcome — how a request ENDED, one of
--       completed, withdrawn, duplicate, handled_out_of_band, rejected (the
--       vocabulary ratified by the integrator under the user's delegation,
--       2026-10-07; lib/ticketOutcome.ts holds the same five). One terminal
--       status per exit (CLOSED / CANCELED) and a reason FIELD, never a
--       status per reason. NULL = not recorded (every request that ended
--       before this paste, and an Admin force close that names none). The
--       workflow route (service role) writes it with the close or the cancel.
--   (2) ticket_update_guard RE-CREATED FROM ITS NEWEST BODY (20261166 — found
--       by scanning; lineDiff-pinned by lib/__tests__/memberDeparture.test.ts:
--       every line of the base is kept, the lines added are exactly DF-P3's):
--         * `outcome` is workflow-owned (a client cannot rewrite how a
--           request ended — the leak count would be forgeable);
--         * the member-departure path (3) passes: a row the departing
--           member held, written inside a trigger by a transaction that
--           marked itself with that member's uid (set_config, which the API
--           cannot reach). Every other client write is decided exactly as
--           20261166 decides it.
--       (The SLA clocks the maintenance cron now stamps — sla_breach_warned_at
--       and sla_breached_at, 20260529 — are already workflow-owned (20261166).
--       The plan's `sla_warned_at` would duplicate sla_breach_warned_at; it
--       is not added.)
--   (3) EDGE-4 (the ratified default: never block a removal — DEC-20 — and
--       never leave a ticket on a uid that cannot sign in): a member who
--       stops being active in an org (suspended, deactivated or removed)
--       hands their in-flight tickets back, with a history line, a bell row
--       to whoever must act, and an audit row on each ticket:
--         * the drafter of a DRAFTING / REVISION_REQ ticket → the ticket
--           returns to PENDING_ASSIGNMENT, drafter cleared;
--         * the drafter of a ticket at any other open status → the drafter
--           is cleared, the status stays (the drafting pool picks up the IFC
--           issue at PENDING_IFC; a revision of a drafterless ticket returns
--           to the queue — lib/ticketTransitions.ts);
--         * the engineer of a PENDING_ENG_TEAM ticket → PENDING_ASSIGNMENT,
--           engineer and the review-requested stamp cleared (an
--           "engineering first" type must be flagged again);
--         * the engineer of a PENDING_FINAL_APPROVAL ticket → back to the
--           requester's review (PENDING_REVIEW), engineer cleared, to send
--           for engineer approval again.
--       It is a SEPARATE pair of triggers on org_members
--       (trg_org_member_departure_status — AFTER UPDATE OF status, active →
--       anything else; trg_org_member_departure_delete — AFTER DELETE),
--       never a change to revoke_member's body: admin-and-org P8 re-creates
--       revoke_member (from its newest body, 20261161) and must not drop
--       these triggers; a removal by any other path is covered the same way.
--       AFTER, not BEFORE: the tickets move only when the membership change
--       itself happened (a BEFORE trigger that ran ahead of a refusing one
--       would have moved them for a member who stayed). A bell row or an
--       audit row that cannot be written is a WARNING and never refuses the
--       removal; the ticket move itself is part of the removal's transaction.
--   (4) The backlog (DEC-30): open tickets ALREADY held by a uid that is not
--       an active member of the ticket's org (the triggers cannot see past
--       departures) are handed back by the same function; and the
--       drafterless REVISION_REQ stragglers (SM-6 / ROUTE-1 — "Return with
--       Questions" from engineering review used to land there, where nobody's
--       queue matched) move to PENDING_ASSIGNMENT with a history line and a
--       bell row to the queue (the 20261053 pattern).
--
-- NOT a widening: nobody gains authority; one column more is refused to a
-- client, and the departure path writes only rows the departed member held.
-- DEC-30 inventory (aggregate counts only, captured BEFORE the transaction):
-- the stragglers, the stranded tickets by role, the requests that ended
-- with no outcome, and the open tickets the SLA clock (maintenance cron)
-- will notify about on its first run.
--
-- HOW TO APPLY: after 20261166 (the first statement refuses to run,
-- changing nothing, without its guard). DEPLOY THE DF-P3 APP FIRST, THEN
-- PASTE THIS. Either app works with or without the paste: before it, the
-- workflow route writes `outcome`, meets 42703 / PGRST204 and retries
-- without the column (today's path — that request's outcome is not
-- recorded), and the analytics block counts it as not recorded. Deploy
-- first because the app before DF-P3 still lands "Return with Questions" in
-- a drafterless REVISION_REQ; this paste moves every straggler made before
-- it. Re-running is safe (idempotent).
-- ⚠ DF-P4 / P6 / P7 / P8 re-create ticket_update_guard FROM THIS BODY (the
-- newest, found by scanning); never re-paste 20261166 after this — it would
-- drop `outcome` and the departure path, and a member removal would then be
-- REFUSED by the guard whenever the member held an open ticket.
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ticket_update_guard'
                  AND prosrc LIKE '%tickets: last_modified cannot be cleared%') THEN
    RAISE EXCEPTION '20261195 needs 20261166 (the DF-P1 ticket rails) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_195_before;
CREATE TEMP TABLE df_round_g_195_before AS
SELECT 1 AS ord, 'inventory (before apply): SM-6 / ROUTE-1 — open REVISION_REQ tickets with no drafter (moved to PENDING_ASSIGNMENT by this paste, a history line and a bell row to the queue each)' AS inventory,
       COUNT(*)::text AS n
  FROM tickets t
 WHERE t.status = 'REVISION_REQ' AND t.assigned_drafter_id IS NULL AND t.archived_at IS NULL
UNION ALL
SELECT 2, 'inventory (before apply): EDGE-4 — open tickets whose DRAFTER is not an active member of the ticket''s org (handed back by this paste)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.status NOT IN ('CLOSED', 'CANCELED') AND t.archived_at IS NULL AND t.assigned_drafter_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.assigned_drafter_id AND m.status = 'active')
UNION ALL
SELECT 3, 'inventory (before apply): EDGE-4 — PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL tickets whose ENGINEER is not an active member (handed back by this paste)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.status IN ('PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL') AND t.archived_at IS NULL AND t.assigned_engineer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.assigned_engineer_id AND m.status = 'active')
UNION ALL
SELECT 4, 'inventory (before apply): LEAK-9 — requests that already ended (CLOSED or CANCELED); their outcome stays NULL ("not recorded" on /admin/analytics) — nothing records how they ended',
       COUNT(*)::text
  FROM tickets WHERE status IN ('CLOSED', 'CANCELED')
UNION ALL
SELECT 5, 'inventory (before apply): GAP-106 — open tickets already past target_completion_at with no breach sent (the first maintenance-cron run after the DF-P3 deploy sends each one breach notice, once)',
       COUNT(*)::text
  FROM tickets
 WHERE status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL AND sla_breached_at IS NULL
   AND target_completion_at IS NOT NULL AND target_completion_at < now()
UNION ALL
SELECT 6, 'inventory (before apply): GAP-106 — open tickets with no target_completion_at (the SLA clock skips them unless their org configured sla_defaults for their type)',
       COUNT(*)::text
  FROM tickets
 WHERE status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL AND target_completion_at IS NULL;

BEGIN;

-- ── 0. Every column this script references exists (20261039's lesson: a
--       plpgsql body is late-bound). 20261166 added the rest; IF NOT EXISTS
--       leaves an existing column alone.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breach_warned_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;
ALTER TABLE document_intents ADD COLUMN IF NOT EXISTS ticket_id UUID;

-- ── 1. LEAK-9 / GAP-107: the outcome vocabulary, held by the database too ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tickets_outcome_check' AND conrelid = 'tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('completed', 'withdrawn', 'duplicate', 'handled_out_of_band', 'rejected'));
  END IF;
END
$$;
COMMENT ON COLUMN tickets.outcome IS
  'drafting-flow LEAK-9 / GAP-107 (20261195): how the request ended — completed, withdrawn, duplicate, handled_out_of_band, rejected; NULL = not recorded. Written by the workflow route with close_ticket / close_rfi / cancel_request; cleared by reopen_ticket. Workflow-owned (ticket_update_guard).';

-- ── 2. ticket_update_guard — re-created from 20261166 (lineDiff-pinned) ─────
CREATE OR REPLACE FUNCTION ticket_update_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad TEXT[] := '{}';
  v_old_len INT;
  v_email TEXT;
  v_entry JSONB;
BEGIN
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

-- DRLS-16: a trigger function is executable by no client role (the trigger
-- fires regardless of EXECUTE; nobody calls it directly).
REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. EDGE-4: a departed member's in-flight tickets go back ───────────────
-- The pool told is the assignment queue's owners, exactly as
-- lib/ticketRouting.ts queuePool() resolves them: active members HOLDING
-- DraftingSupervisor (headline or collection, trimmed — heldRoles()), else
-- the Admin holders; both when the org's drafting routing says
-- adminsAlsoReceiveWhenSupervisorSet. A ticket returned to the requester's
-- review tells the requester. The departed member is never told.
CREATE OR REPLACE FUNCTION return_departed_member_tickets(p_org uuid, p_uid uuid, p_label text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_who      text := COALESCE(NULLIF(btrim(p_label), ''), 'A former member');
  v_sup      uuid[];
  v_adm      uuid[];
  v_both     boolean := false;
  v_pool     uuid[];
  v_t        record;
  v_status   text;
  v_drafter  boolean;
  v_engineer boolean;
  v_action   text;
  v_line     text;
  v_tell     uuid[];
  v_now      text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_n        integer := 0;
BEGIN
  IF p_org IS NULL OR p_uid IS NULL THEN
    RETURN 0;
  END IF;
  -- Still (or again) an active member of this org: nothing departed.
  IF EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = p_org AND m.uid = p_uid AND m.status = 'active') THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m.uid), '{}'::uuid[]) INTO v_sup
    FROM org_members m
   WHERE m.org_id = p_org AND m.status = 'active' AND m.uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) AS h(r)
                  WHERE btrim(h.r) = 'DraftingSupervisor');
  SELECT COALESCE(array_agg(DISTINCT m.uid), '{}'::uuid[]) INTO v_adm
    FROM org_members m
   WHERE m.org_id = p_org AND m.status = 'active' AND m.uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) AS h(r)
                  WHERE btrim(h.r) = 'Admin');
  SELECT COALESCE((c.data -> 'routing' -> 'adminsAlsoReceiveWhenSupervisorSet') = 'true'::jsonb, false) INTO v_both
    FROM org_configurations c WHERE c.org_id = p_org AND c.key = 'drafting' LIMIT 1;
  v_pool := CASE WHEN cardinality(v_sup) = 0 THEN v_adm
                 WHEN COALESCE(v_both, false) THEN v_sup || v_adm
                 ELSE v_sup END;

  -- The mark ticket_update_guard honours (this transaction only).
  PERFORM set_config('app.ticket_departure', p_uid::text, true);

  FOR v_t IN
    SELECT t.id, t.ticket_id, t.title, t.status, t.requester_id, t.assigned_drafter_id, t.assigned_engineer_id
      FROM tickets t
     WHERE t.org_id = p_org AND t.archived_at IS NULL AND t.status NOT IN ('CLOSED', 'CANCELED')
       AND (t.assigned_drafter_id = p_uid
            OR (t.assigned_engineer_id = p_uid AND t.status IN ('PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL')))
     ORDER BY t.created_at, t.id
     FOR UPDATE
  LOOP
    v_drafter  := v_t.assigned_drafter_id IS NOT DISTINCT FROM p_uid;
    v_engineer := v_t.assigned_engineer_id IS NOT DISTINCT FROM p_uid
                  AND v_t.status IN ('PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL');
    v_status := v_t.status;
    IF v_engineer AND v_t.status = 'PENDING_ENG_TEAM' THEN
      v_status := 'PENDING_ASSIGNMENT';
    ELSIF v_engineer AND v_t.status = 'PENDING_FINAL_APPROVAL' THEN
      v_status := 'PENDING_REVIEW';
    END IF;
    IF v_drafter AND v_status IN ('DRAFTING', 'REVISION_REQ') THEN
      v_status := 'PENDING_ASSIGNMENT';
    END IF;

    IF v_status = 'PENDING_ASSIGNMENT' THEN
      v_action := 'Returned to the assignment queue';
      v_line := v_who || ', the ' || CASE WHEN v_engineer THEN 'reviewing engineer' ELSE 'drafter' END
                || ', is no longer an active member of this workspace. The request is back in the assignment queue.';
      v_tell := v_pool;
    ELSIF v_status = 'PENDING_REVIEW' AND v_engineer THEN
      v_action := 'Returned to the requester''s review';
      v_line := v_who || ', the reviewing engineer, is no longer an active member of this workspace. Send the request for engineer approval again.';
      v_tell := v_pool || ARRAY[v_t.requester_id];
    ELSE
      v_action := 'Drafter cleared';
      v_line := v_who || ', the drafter, is no longer an active member of this workspace. The drafting pool can pick up this request.';
      v_tell := v_pool;
    END IF;
    v_tell := ARRAY(SELECT DISTINCT u FROM unnest(v_tell) AS x(u) WHERE u IS NOT NULL AND u IS DISTINCT FROM p_uid);

    UPDATE tickets t
       SET status                       = v_status,
           assigned_drafter_id          = CASE WHEN v_drafter THEN NULL ELSE t.assigned_drafter_id END,
           assigned_drafter_name        = CASE WHEN v_drafter THEN NULL ELSE t.assigned_drafter_name END,
           assigned_engineer_id         = CASE WHEN v_engineer THEN NULL ELSE t.assigned_engineer_id END,
           assigned_engineer_name       = CASE WHEN v_engineer THEN NULL ELSE t.assigned_engineer_name END,
           assigned_engineer_email      = CASE WHEN v_engineer THEN NULL ELSE t.assigned_engineer_email END,
           engineer_review_requested_at = CASE WHEN v_engineer AND v_t.status = 'PENDING_ENG_TEAM' THEN NULL
                                               ELSE t.engineer_review_requested_at END,
           history                      = COALESCE(t.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                                            'action', v_action, 'user', 'system', 'role', 'System',
                                            'date', v_now, 'details', v_line)),
           unread_by                    = ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(t.unread_by, '{}'::uuid[]) || v_tell) AS x(u)
                                                 WHERE u IS DISTINCT FROM p_uid),
           last_modified                = now()
     WHERE t.id = v_t.id;

    -- The departed drafter's ticket-sourced edit intent goes with them.
    IF v_drafter THEN
      DELETE FROM document_intents WHERE ticket_id = v_t.id AND user_id = p_uid AND source = 'ticket';
    END IF;

    -- Never silent, never a refusal: a bell row to whoever must act and an
    -- audit row on the ticket; either failing is a WARNING.
    BEGIN
      IF cardinality(v_tell) > 0 THEN
        INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_name, metadata)
        SELECT p_org, u, 'ticket_status',
               v_action || ' · ' || btrim(COALESCE(v_t.ticket_id, '') || ' ' || COALESCE(v_t.title, '')),
               v_line, '/requests/' || v_t.id::text, 'ticket', v_t.id::text, 'System',
               jsonb_build_object('action', 'member_departed', 'status', v_status)
          FROM unnest(v_tell) AS x(u);
      END IF;
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
      VALUES ('TICKET_RETURNED_ON_DEPARTURE', v_t.id::text, 'ticket', p_org, auth.uid(),
              jsonb_build_object('departedUid', p_uid, 'from', v_t.status, 'to', v_status,
                                 'drafterCleared', v_drafter, 'engineerCleared', v_engineer, 'told', to_jsonb(v_tell)));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'return_departed_member_tickets: ticket % was handed back, but its notice or audit row was not written: %', v_t.id, SQLERRM;
    END;
    v_n := v_n + 1;
  END LOOP;

  PERFORM set_config('app.ticket_departure', '', true);
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION return_departed_member_tickets(uuid, uuid, text) IS
  'drafting-flow EDGE-4 (20261195): hands a departed member''s in-flight tickets in one org back — DRAFTING / REVISION_REQ and PENDING_ENG_TEAM to the assignment queue, PENDING_FINAL_APPROVAL to the requester''s review, any other open status with the drafter cleared — with a history line, a bell row and an audit row each. Answers 0 for a member who is still active. Run by the org_members departure triggers and by 20261195''s backlog move; service role only.';
-- DRLS-16: definer, search_path pinned; no client may call it.
REVOKE ALL ON FUNCTION return_departed_member_tickets(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION return_departed_member_tickets(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION org_member_departure_returns_tickets()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM return_departed_member_tickets(OLD.org_id, OLD.uid,
                                         COALESCE(NULLIF(btrim(OLD.display_name), ''), split_part(COALESCE(OLD.email, ''), '@', 1)));
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION org_member_departure_returns_tickets() IS
  'drafting-flow EDGE-4 (20261195): the org_members departure triggers'' function — a SEPARATE trigger, never part of revoke_member''s body (admin-and-org P8 re-creates revoke_member and must keep these triggers).';
REVOKE ALL ON FUNCTION org_member_departure_returns_tickets() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_org_member_departure_status ON org_members;
CREATE TRIGGER trg_org_member_departure_status
  AFTER UPDATE OF status ON org_members
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION org_member_departure_returns_tickets();
DROP TRIGGER IF EXISTS trg_org_member_departure_delete ON org_members;
CREATE TRIGGER trg_org_member_departure_delete
  AFTER DELETE ON org_members
  FOR EACH ROW
  EXECUTE FUNCTION org_member_departure_returns_tickets();

-- ── 4. The backlog (DEC-30): what the triggers cannot see ───────────────────
-- (a) open tickets already held by a uid that is not an active member of
--     the ticket's org — handed back by the same function, labelled from the
--     member row when one is left.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT s.org_id, s.uid
      FROM (SELECT t.org_id, t.assigned_drafter_id AS uid FROM tickets t
             WHERE t.status NOT IN ('CLOSED', 'CANCELED') AND t.archived_at IS NULL AND t.assigned_drafter_id IS NOT NULL
            UNION
            SELECT t.org_id, t.assigned_engineer_id FROM tickets t
             WHERE t.status IN ('PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL') AND t.archived_at IS NULL
               AND t.assigned_engineer_id IS NOT NULL) AS s
     WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = s.org_id AND m.uid = s.uid AND m.status = 'active')
  LOOP
    PERFORM return_departed_member_tickets(r.org_id, r.uid,
      (SELECT COALESCE(NULLIF(btrim(m.display_name), ''), split_part(COALESCE(m.email, ''), '@', 1))
         FROM org_members m WHERE m.org_id = r.org_id AND m.uid = r.uid LIMIT 1));
  END LOOP;
END
$$;

-- (b) SM-6 / ROUTE-1: the drafterless REVISION_REQ stragglers return to the
--     assignment queue (the state is unreachable from the DF-P3 app on).
DO $$
DECLARE
  r      record;
  v_pool uuid[];
  v_line text := 'Returned for revision with no drafter assigned, where no queue showed it. It is back in the assignment queue for a drafter to be assigned.';
  v_now  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  FOR r IN
    SELECT t.id, t.org_id, t.ticket_id, t.title FROM tickets t
     WHERE t.status = 'REVISION_REQ' AND t.assigned_drafter_id IS NULL AND t.archived_at IS NULL
     ORDER BY t.created_at, t.id
  LOOP
    SELECT CASE WHEN cardinality(s.sup) = 0 THEN s.adm
                WHEN COALESCE((SELECT (c.data -> 'routing' -> 'adminsAlsoReceiveWhenSupervisorSet') = 'true'::jsonb
                                 FROM org_configurations c WHERE c.org_id = r.org_id AND c.key = 'drafting' LIMIT 1), false)
                  THEN s.sup || s.adm
                ELSE s.sup END
      INTO v_pool
      FROM (SELECT
              COALESCE((SELECT array_agg(DISTINCT m.uid) FROM org_members m
                         WHERE m.org_id = r.org_id AND m.status = 'active' AND m.uid IS NOT NULL
                           AND EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) AS h(x)
                                        WHERE btrim(h.x) = 'DraftingSupervisor')), '{}'::uuid[]) AS sup,
              COALESCE((SELECT array_agg(DISTINCT m.uid) FROM org_members m
                         WHERE m.org_id = r.org_id AND m.status = 'active' AND m.uid IS NOT NULL
                           AND EXISTS (SELECT 1 FROM unnest(ARRAY[m.role] || COALESCE(m.roles, '{}'::text[])) AS h(x)
                                        WHERE btrim(h.x) = 'Admin')), '{}'::uuid[]) AS adm) AS s;
    UPDATE tickets t
       SET status        = 'PENDING_ASSIGNMENT',
           history       = COALESCE(t.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                             'action', 'Returned to the assignment queue', 'user', 'system', 'role', 'System',
                             'date', v_now, 'details', v_line)),
           unread_by     = ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(t.unread_by, '{}'::uuid[]) || v_pool) AS x(u)),
           last_modified = now()
     WHERE t.id = r.id AND t.status = 'REVISION_REQ' AND t.assigned_drafter_id IS NULL;
    IF cardinality(v_pool) > 0 THEN
      INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_name, metadata)
      SELECT r.org_id, u, 'ticket_status',
             'Returned to the assignment queue · ' || btrim(COALESCE(r.ticket_id, '') || ' ' || COALESCE(r.title, '')),
             v_line, '/requests/' || r.id::text, 'ticket', r.id::text, 'System',
             jsonb_build_object('action', 'revision_without_drafter', 'status', 'PENDING_ASSIGNMENT')
        FROM unnest(v_pool) AS x(u);
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 10. Inventory rows: n = the aggregate count before the
-- apply. pg_proc.prosrc is verbatim (an apostrophe inside a body's string
-- literal is '''' here).
SELECT 'LEAK-9 / GAP-107: tickets.outcome exists, CHECKed to completed / withdrawn / duplicate / handled_out_of_band / rejected (or NULL)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'outcome')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_outcome_check' AND conrelid = 'tickets'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%completed%' AND pg_get_constraintdef(oid) LIKE '%withdrawn%'
                    AND pg_get_constraintdef(oid) LIKE '%duplicate%' AND pg_get_constraintdef(oid) LIKE '%handled_out_of_band%'
                    AND pg_get_constraintdef(oid) LIKE '%rejected%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'ticket_update_guard owns outcome, and still owns the 37 columns 20261166 decided (the SLA clocks among them)',
       (SELECT bool_and(p.prosrc LIKE '%IF NEW.' || c.col || ' %IS DISTINCT FROM OLD.' || c.col || ' %THEN v_bad := array_append(v_bad, ''' || c.col || ''');%')
          FROM pg_proc p
         CROSS JOIN unnest(ARRAY['outcome','org_id','ticket_id','status','requester_id','requester_role','requester_name','requester_email',
                                 'assigned_drafter_id','assigned_drafter_name','assigned_engineer_id','assigned_engineer_name',
                                 'assigned_engineer_email','engineer_review_requested_at','engineer_approved_at','engineer_review_reason',
                                 'deliverable_rev','draft_iteration','revision_count','closed_at','archived_at','archive_id','created_at',
                                 'id','title','description','request_type','unit','attachments','comments','metadata','watchers',
                                 'search_keywords','search_tsv','target_completion_at','sla_breach_warned_at','sla_breached_at','updated_at']) AS c(col)
         WHERE p.proname = 'ticket_update_guard'),
       NULL
UNION ALL
SELECT 'ticket_update_guard keeps every 20261166 rail (service-role pass, shrink block, append-only history in the caller''s name, own unread marker, last_modified never cleared) and passes only the marked departure path from inside a trigger',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
           AND prosrc LIKE '%RAISE EXCEPTION ''tickets: the history log cannot shrink'';%'
           AND prosrc LIKE '%RAISE EXCEPTION ''tickets: history entries cannot be changed — the log is append-only'';%'
           AND prosrc LIKE '%RAISE EXCEPTION ''tickets: a history entry you add must name you'';%'
           AND prosrc LIKE '%NEW.unread_by := array_remove(COALESCE(OLD.unread_by, ''{}''::uuid[]), auth.uid());%'
           AND prosrc LIKE '%IF NEW.last_modified IS NULL AND OLD.last_modified IS NOT NULL THEN%'
           AND prosrc LIKE '%IF pg_trigger_depth() > 1%current_setting(''app.ticket_departure'', true) IN (OLD.assigned_drafter_id::text, OLD.assigned_engineer_id::text) THEN%'
          FROM pg_proc WHERE proname = 'ticket_update_guard'),
       NULL
UNION ALL
SELECT 'the guard is SECURITY DEFINER with search_path pinned, no client role may execute it, and trg_ticket_update_guard (BEFORE UPDATE) still fires it',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'ticket_update_guard'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'ticket_update_guard()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_ticket_update_guard' AND NOT t.tgisinternal
                      AND t.tgrelid = 'tickets'::regclass AND p.proname = 'ticket_update_guard'),
       NULL
UNION ALL
SELECT 'EDGE-4: return_departed_member_tickets and org_member_departure_returns_tickets are SECURITY DEFINER with search_path pinned; anon, authenticated and PUBLIC cannot execute either',
       (SELECT COUNT(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('return_departed_member_tickets', 'org_member_departure_returns_tickets')
           AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'return_departed_member_tickets(uuid, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'return_departed_member_tickets(uuid, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'org_member_departure_returns_tickets()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'org_member_departure_returns_tickets()', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                        WHERE p.proname IN ('return_departed_member_tickets', 'org_member_departure_returns_tickets')
                          AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'EDGE-4: the two departure triggers are on org_members — AFTER UPDATE OF status (active → anything else) and AFTER DELETE — and revoke_member''s body does not carry them (a separate trigger: admin-and-org P8 re-creates revoke_member and must keep these)',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trg_org_member_departure_status' AND t.tgrelid = 'org_members'::regclass AND NOT t.tgisinternal
                  AND p.proname = 'org_member_departure_returns_tickets'
                  AND pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE OF status ON%'
                  AND pg_get_triggerdef(t.oid) LIKE '%old.status = ''active''%')
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_org_member_departure_delete' AND t.tgrelid = 'org_members'::regclass AND NOT t.tgisinternal
                      AND p.proname = 'org_member_departure_returns_tickets'
                      AND pg_get_triggerdef(t.oid) LIKE '%AFTER DELETE ON%')
       AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member' AND prosrc LIKE '%return_departed_member_tickets%'),
       NULL
UNION ALL
SELECT 'SM-6 / ROUTE-1: no open REVISION_REQ ticket is left without a drafter',
       NOT EXISTS (SELECT 1 FROM tickets WHERE status = 'REVISION_REQ' AND assigned_drafter_id IS NULL AND archived_at IS NULL),
       NULL
UNION ALL
SELECT 'EDGE-4: no open ticket is left on a drafter who is not an active member of its org',
       NOT EXISTS (SELECT 1 FROM tickets t
                    WHERE t.status NOT IN ('CLOSED', 'CANCELED') AND t.archived_at IS NULL AND t.assigned_drafter_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.assigned_drafter_id AND m.status = 'active')),
       NULL
UNION ALL
SELECT 'EDGE-4: no PENDING_ENG_TEAM / PENDING_FINAL_APPROVAL ticket waits on an engineer who is not an active member of its org',
       NOT EXISTS (SELECT 1 FROM tickets t
                    WHERE t.status IN ('PENDING_ENG_TEAM', 'PENDING_FINAL_APPROVAL') AND t.archived_at IS NULL AND t.assigned_engineer_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.assigned_engineer_id AND m.status = 'active')),
       NULL
UNION ALL
SELECT 'the departure path is not left marked after this paste (app.ticket_departure is empty in this session)',
       COALESCE(current_setting('app.ticket_departure', true), '') = '',
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT ord, inventory, n FROM df_round_g_195_before ORDER BY ord) AS i;
