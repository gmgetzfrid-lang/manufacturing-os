-- ─────────────────────────────────────────────────────────────────────────────
-- 20261221_df_roundG_issue_lines_server_only.sql
--
-- drafting-flow Round G — DF-P12 DELIVERABLE FOLLOW-UPS: an "issued Rev N"
-- history line is written by the request workflow only (SM-5's guard limb,
-- EDGE-2 / PHYS-2's forged-line residual), and the row says from where on
-- its history is the workflow's own.
--
--   (1) ticket_update_guard RE-CREATED FROM ITS NEWEST BODY (20261208 —
--       found by scanning; lineDiff-pinned by
--       lib/__tests__/dfRoundG_P12_deliverable.test.ts). Every line of the base
--       is kept. Added:
--         (a) the limb — a client-appended history entry whose `action`
--             matches 'issued Rev <digit>' (any case, any JSON shape) is
--             refused. The readers (lib/verifyTicketVerdict.ts, the copy
--             stamp in lib/ticketDeliverableCopy.ts, the SM-5 re-cycle in
--             lib/ticketTransitions.ts) read /\bissued Rev (\d+)\b/ out of
--             `action`; the match here is wider, never narrower. Before this
--             paste any member could append such a line in their own name
--             (20261166's append-only rule names the caller, nothing more).
--             Likewise an appended entry carrying a `revisionRound` key — the
--             marker lib/ticketTransitions.ts computeTransition records on the
--             round a request for revision, a reject or reject_final opens; the
--             verdict reads round N after a proven issue N as "the issued
--             package was sent back" (DEC-44 (DF-P12) item 2). No browser path
--             writes one either.
--         (b) tickets.history_guarded_from — the index in `history` from
--             which every "issued Rev N" line is the workflow's own. Stamped
--             by the guard, ahead of every early return: once, on a live
--             row's first write after this paste, with the history length the
--             row had before that write; CLEARED by the shed (live →
--             archived — the stub's history goes to the archive bundle); and
--             RE-STAMPED by every restore (archived → live) at the full
--             length the restore writes, whatever the row carried — the
--             restore writes history from an admin-uploaded archive bundle
--             (app/api/admin/ticket-shed/restore, which checks only the
--             attachment bytes against the bundle's manifest), so nothing
--             restored is proven. Workflow-owned: a client write of it is
--             refused. /api/verify-ticket reads it (lib/verifyTicketVerdict.ts
--             provenIssueFromHistory): an issue line at or after the index is
--             proven, and the integrator's DEC-90 rulings that answer "cannot
--             confirm" because a history line might be forged are lifted for
--             a ticket whose last issue is proven. A ticket with no proven
--             issue keeps DF-P10's trust boundary (the DF-P12 demotions that
--             act on every row, with or without the index, are listed in
--             lib/verifyTicketVerdict.ts; each only turns an answer grey).
--   (2) ticket_history_guard_reset() (new; SECURITY INVOKER, search_path
--       pinned) and trg_ticket_history_guard_reset BEFORE INSERT: a ticket row
--       born by INSERT proves nothing about its history (a restore, any
--       service-role insert), so the index is cleared; the row's first update
--       stamps it.
--
-- WHY THE INDEX. A history line appended BEFORE this paste may be a member's
-- (DEC-90, fail-safe: history the server did not write is never trusted), and
-- nothing on the line tells it apart from an approval's. From the paste on, a
-- client cannot write one, so the lines a row gains after its first write
-- under this guard are the server's — save a restore's, which come from an
-- uploaded bundle and so start the index again past everything restored.
-- Every real issue is a higher number than
-- every real issue before it (lib/ticketTransitions.ts issueLabelFor re-cycles
-- a label the history already issued), so once a ticket has a proven issue,
-- an older line claiming a higher number is provably not an approval's.
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261208 (its first statement refuses
-- otherwise, changing nothing). Either order with the DF-P12 deploy: the
-- DF-P12 app reads history_guarded_from and, without the column (42703 /
-- PGRST204), proves no issue line — it keeps DF-P10's trust boundary until
-- the paste (the two DF-P12 demotions that need no index — the CLOSED
-- issued-label rule and the ?a= identity check — act from the deploy: they
-- only turn an answer grey, and neither reads member-written history; the
-- label-issued-twice rule counts only lines at or after the index, so it
-- acts only after this paste — DEC-90 ruling R2 at the DF-P12 merge). The
-- app before DF-P12 never selects the column.
-- No browser path appends an "issued Rev" line or a `revisionRound` marker
-- (the workflow route writes both as the service role; the one browser
-- history writer, lib/projects.ts convertTicketToProject, appends "Converted
-- to Project"), so nothing that works today is refused.
-- Never re-paste 20261208, 20261195, 20261166 or 20261038 after this file
-- (each would put back a guard without the limb and without the index
-- stamp). Every later re-creation of ticket_update_guard starts from THIS
-- file's body and keeps both limbs and the index stamp — a re-creation that
-- drops a limb must also drop (or clear) tickets.history_guarded_from in the
-- same paste, or the index would vouch for lines nobody guarded
-- (lib/__tests__/dfRoundG_P12_deliverable.test.ts scans the folder for the
-- newest body and refuses one without them).
--
-- Not a widening (it narrows: a client can no longer append an issue line or
-- a revision-round marker, or write the index). Re-runnable: ADD COLUMN IF NOT EXISTS, the CHECK is added
-- once, the functions are CREATE OR REPLACE, the triggers DROP-then-CREATE.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ticket_update_guard'
                  AND prosrc LIKE '%v_bad := array_append(v_bad, ''library_id'');%') THEN
    RAISE EXCEPTION '20261221 needs 20261208 (the DF-P4 ticket library rails) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_221_before;
CREATE TEMP TABLE df_round_g_221_before AS
SELECT 1 AS ord, 'inventory (before apply): tickets (all)' AS inventory,
       COUNT(*)::text AS n
  FROM tickets
UNION ALL
SELECT 2, 'inventory (before apply): tickets whose history carries an "issued Rev N" line (the evidence the verify verdict reads; written before this paste, so none is proven)',
       COUNT(*)::text
  FROM tickets t
 WHERE jsonb_typeof(t.history) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.history) h(e)
                WHERE COALESCE(h.e->>'action', '') ~ '[[:<:]]issued Rev [0-9]+[[:>:]]')
UNION ALL
SELECT 3, 'inventory (before apply): SM-5 — tickets whose history carries an "issued Rev N" line ABOVE revision_count + 1 (no approval wrote it: a client append the readers already ignore)',
       COUNT(*)::text
  FROM tickets t
 WHERE jsonb_typeof(t.history) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.history) h(e),
                      LATERAL regexp_matches(COALESCE(h.e->>'action', ''), '[[:<:]]issued Rev ([0-9]+)[[:>:]]') AS m(g)
                WHERE m.g[1]::numeric > COALESCE(t.revision_count, 0) + 1)
UNION ALL
SELECT 4, 'inventory (before apply): archived tickets (their history is in the archive bundle; every restore re-stamps the index over everything it puts back)',
       COUNT(*)::text
  FROM tickets WHERE archived_at IS NOT NULL;

BEGIN;

-- ── 1. the history trust index ─────────────────────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS history_guarded_from INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tickets_history_guarded_from_nonnegative'
                    AND conrelid = 'public.tickets'::regclass) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_history_guarded_from_nonnegative
      CHECK (history_guarded_from IS NULL OR history_guarded_from >= 0);
  END IF;
END
$$;
COMMENT ON COLUMN tickets.history_guarded_from IS
  'drafting-flow SM-5 / EDGE-2 (20261221): the index in history from which every "issued Rev N" line is the request workflow''s own (ticket_update_guard refuses a client-appended one from this paste on). Stamped by the guard on a live row''s first update after the paste, cleared by the archive shed, re-stamped at the full restored length by every restore; NULL = nothing proven (never updated since, archived, or born by INSERT). Workflow-owned.';

-- ── 2. ticket_update_guard — re-created from 20261208 (lineDiff-pinned) ─────
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

-- ── 3. a row born by INSERT proves nothing about its history ───────────────
-- New function (no earlier body). SECURITY INVOKER: it only clears one field
-- of the row being inserted and reads nothing.
CREATE OR REPLACE FUNCTION ticket_history_guard_reset()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- A restored or otherwise inserted ticket's history was not written under
  -- ticket_update_guard on this database: its first update stamps the index.
  NEW.history_guarded_from := NULL;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ticket_history_guard_reset ON tickets;
CREATE TRIGGER trg_ticket_history_guard_reset
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_history_guard_reset();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_history_guard_reset() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'SM-5: tickets.history_guarded_from exists (integer, never negative)' AS check,
       (EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'history_guarded_from' AND data_type = 'integer')
        AND EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'tickets_history_guarded_from_nonnegative' AND conrelid = 'public.tickets'::regclass AND contype = 'c')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'ticket_update_guard: refuses a client-appended "issued Rev" line or revisionRound marker, stamps and owns history_guarded_from (cleared by a shed, re-stamped by every restore); library_id, outcome, the departure pass and the last_modified rule kept; SECURITY DEFINER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_update_guard' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_update_guard' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%IF COALESCE(v_entry->>''action'', '''') ~* ''issued Rev [[:digit:]]'' THEN%'
                  AND p.prosrc LIKE '%IF v_entry ? ''revisionRound'' THEN%'
                  AND p.prosrc LIKE '%NEW.history_guarded_from := CASE%'
                  AND p.prosrc LIKE '%IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN%'
                  AND p.prosrc LIKE '%ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''history_guarded_from'');%'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''library_id'');%'
                  AND p.prosrc LIKE '%array_append(v_bad, ''outcome''); END IF;%'
                  AND p.prosrc LIKE '%app.ticket_departure%'
                  AND p.prosrc LIKE '%tickets: last_modified cannot be cleared%'),
       NULL
UNION ALL
SELECT 'ticket_history_guard_reset: clears the index on every INSERT; SECURITY INVOKER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_history_guard_reset' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_history_guard_reset' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%NEW.history_guarded_from := NULL;%'),
       NULL
UNION ALL
SELECT 'DRLS-16: neither trigger function is executable by anon or authenticated',
       NOT has_function_privilege('anon', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_history_guard_reset()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_history_guard_reset()', 'EXECUTE'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_221_before ORDER BY ord) b
UNION ALL
SELECT 'after: tickets carrying a history trust index (0 right after the paste: each ticket''s next write stamps it)', NULL,
       (SELECT COUNT(*) FROM tickets WHERE history_guarded_from IS NOT NULL)::text;
