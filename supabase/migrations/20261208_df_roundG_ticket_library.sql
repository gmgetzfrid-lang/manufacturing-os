-- ─────────────────────────────────────────────────────────────────────────────
-- 20261208_df_roundG_ticket_library.sql
--
-- drafting-flow Round G — DF-P4 LIBRARY: the ticket gets a library (GAP-105,
-- DCW-1), and the last client-chosen requester field closes (AUTHZ-3).
--
--   (1) GAP-105 / DCW-1: tickets.library_id UUID REFERENCES libraries(id)
--       ON DELETE SET NULL, with a partial index. NULL means "no library
--       known yet" — it is NEVER required at intake (99-fix-sequencing
--       Phase 2 item 1, "Do not make it required at intake"); triage may set
--       it. A library is the document's own (documents.library_id — the root
--       of the one container chain, lib/containerChain.ts, DEC-36); nothing
--       here walks folders.
--   (2) BACKFILL: every ticket that has none and whose singular source
--       document (metadata.source_document.id) is a document IN THE TICKET'S
--       ORG takes that document's library (SM-14: a document id from another
--       workspace lends nothing). A ticket with no source document, or one
--       whose source is gone or foreign, stays NULL (triage sets it).
--   (3) ticket_update_guard RE-CREATED FROM ITS NEWEST BODY (20261195 —
--       found by scanning; lineDiff-pinned by
--       lib/__tests__/dfRoundG_P4_library.test.ts): every line of the base is
--       kept; the lines added make library_id workflow-owned (the create route
--       and the triage action write it as the service role), passing only the
--       library's own deletion (ON DELETE SET NULL, inside the delete's
--       trigger, once the library row is gone).
--   (4) ticket_insert_integrity RE-CREATED FROM ITS NEWEST BODY (20261195):
--       a client insert is born with no library and with the requester's own
--       name from their membership (display name, else the email's local
--       part — the create route's rule). The three DF-P3 lines (no SLA stamps,
--       no outcome) are kept, contiguous.
--   (5) AUTHZ-3: tickets_org_insert (20261166) is DROPPED. Since DF-P2 no app
--       path inserts a ticket from a browser — /api/tickets/create inserts
--       as the service role, which RLS does not govern — so a member's
--       hand-written PostgREST insert (the only remaining way to choose a
--       requester_name) is refused. There is no other INSERT policy on
--       tickets (20261166 split FOR ALL per verb), so after this paste a
--       signed-in client inserts no ticket at all.
--
-- PASTE / DEPLOY ORDER. Deploy the app carrying drafting-flow DF-P2 (the
-- create route) first — it is live on every branch after DF-P2's merge —
-- then paste this AFTER 20261195 (its first statement refuses otherwise,
-- changing nothing). Never before the DF-P2 deploy: until then the three
-- creators insert from the browser and would be refused by (5). The app
-- carrying DF-P4 works BEFORE and AFTER this paste: the create route and the
-- workflow route write library_id; without the column (42703 / PGRST204)
-- each retries without it — today's path, the ticket simply has no library
-- — and every reader treats a missing column as "no library".
-- Never re-paste 20261195, 20261166 or 20261038 after this file (each would
-- put back an older guard without library_id; 20261166 would also bring
-- tickets_org_insert back). Every later re-creation of ticket_update_guard /
-- ticket_insert_integrity starts from THIS file's bodies.
--
-- Not a widening (it narrows: a client can no longer write library_id or
-- insert a ticket). Re-runnable: ADD COLUMN / INDEX IF NOT EXISTS, the
-- backfill touches only rows still NULL, the functions are CREATE OR REPLACE,
-- the policy drop is IF EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ticket_update_guard'
                  AND prosrc LIKE '%''outcome''); END IF;%') THEN
    RAISE EXCEPTION '20261208 needs 20261195 (the DF-P3 outcome and departure rails) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_208_before;
CREATE TEMP TABLE df_round_g_208_before AS
SELECT 1 AS ord, 'inventory (before apply): tickets (all)' AS inventory,
       COUNT(*)::text AS n
  FROM tickets
UNION ALL
SELECT 2, 'inventory (before apply): GAP-105 — tickets whose source document is a document of their own org (backfilled with that document''s library, when it has one)',
       COUNT(*)::text
  FROM tickets t
 WHERE (t.metadata->'source_document'->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND EXISTS (SELECT 1 FROM documents d WHERE d.id::text = t.metadata->'source_document'->>'id' AND d.org_id = t.org_id)
UNION ALL
SELECT 3, 'inventory (before apply): GAP-105 — tickets naming a source document that is gone or in another org (no derivable library; stay NULL, triage sets it)',
       COUNT(*)::text
  FROM tickets t
 WHERE COALESCE(t.metadata->'source_document'->>'id', '') <> ''
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id::text = t.metadata->'source_document'->>'id' AND d.org_id = t.org_id)
UNION ALL
SELECT 4, 'inventory (before apply): GAP-105 — tickets with no source document (no derivable library; stay NULL, triage sets it)',
       COUNT(*)::text
  FROM tickets t
 WHERE COALESCE(t.metadata->'source_document'->>'id', '') = ''
UNION ALL
SELECT 5, 'inventory (before apply): GAP-105 — multi-sheet tickets whose sheets (metadata.source_documents) span more than one library (the backfill takes the primary sheet''s; triage may correct it)',
       COUNT(*)::text
  FROM tickets t
 WHERE jsonb_typeof(t.metadata->'source_documents') = 'array'
   AND (SELECT COUNT(DISTINCT d.library_id)
          FROM jsonb_array_elements(t.metadata->'source_documents') s
          JOIN documents d ON d.id::text = s->>'id' AND d.org_id = t.org_id) > 1
UNION ALL
SELECT 6, 'inventory (before apply): AUTHZ-3 — tickets whose requester_name is not their requester''s membership name (display name, else email local part) — counted, not rewritten',
       COUNT(*)::text
  FROM tickets t
  JOIN org_members m ON m.org_id = t.org_id AND m.uid = t.requester_id
 WHERE t.requester_name IS DISTINCT FROM COALESCE(NULLIF(btrim(m.display_name), ''), NULLIF(split_part(COALESCE(m.email, ''), '@', 1), ''), 'Unknown')
UNION ALL
SELECT 7, 'inventory (before apply): AUTHZ-3 — INSERT policies on tickets (tickets_org_insert is dropped by this paste)',
       COUNT(*)::text
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND cmd IN ('INSERT', 'ALL');

BEGIN;

-- ── 1. GAP-105 / DCW-1: the ticket's library ───────────────────────────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS library_id UUID REFERENCES libraries(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_library_idx ON tickets(library_id) WHERE library_id IS NOT NULL;
COMMENT ON COLUMN tickets.library_id IS
  'drafting-flow GAP-105 / DCW-1 (20261208): the library this request targets — derived by /api/tickets/create from the source document (documents.library_id), set or corrected at triage by /api/tickets/workflow-action (assign / request_eng_review at PENDING_ASSIGNMENT). NULL = not known yet; never required at intake. Workflow-owned (ticket_update_guard); cleared when the library is deleted.';

-- ── 2. Backfill from the source document, in the ticket's own org ──────────
-- Runs as the paste's owner (auth.uid() IS NULL: the guard passes it). Only
-- rows still NULL are touched, so a re-paste never overwrites a library
-- triage set.
UPDATE tickets t
   SET library_id = d.library_id
  FROM documents d
 WHERE t.library_id IS NULL
   AND (t.metadata->'source_document'->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   AND d.id::text = t.metadata->'source_document'->>'id'
   AND d.org_id = t.org_id
   AND d.library_id IS NOT NULL;

-- ── 3. ticket_update_guard — re-created from 20261195 (lineDiff-pinned) ─────
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
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_update_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. ticket_insert_integrity — re-created from 20261195 (lineDiff-pinned) ─
CREATE OR REPLACE FUNCTION ticket_insert_integrity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  TEXT;
  v_roles TEXT[];
  v_email TEXT;
  v_types TEXT[];
  v_name  TEXT;
BEGIN
  -- Service-role writes (API routes) stamp identity themselves.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  SELECT role, COALESCE(roles, ARRAY[role]), email INTO v_role, v_roles, v_email
  FROM org_members
  WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active'
  LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'tickets: only active members of the workspace can create requests';
  END IF;

  -- WF-5: the requester is the caller — not whoever the payload names.
  NEW.requester_id := auth.uid();
  IF v_email IS NOT NULL THEN
    NEW.requester_email := v_email;
  END IF;
  -- The stamped role must be one the caller actually HOLDS (multi-role
  -- members may file under any of their roles); otherwise their primary.
  IF NEW.requester_role IS NULL OR NOT (NEW.requester_role = ANY(v_roles)) THEN
    NEW.requester_role := v_role;
  END IF;
  -- Tickets are born in the assignment queue, never mid-workflow.
  NEW.status := 'PENDING_ASSIGNMENT';
  -- Nothing is approved, closed, or archived at birth.
  NEW.assigned_drafter_id := NULL;
  NEW.assigned_drafter_name := NULL;
  NEW.assigned_engineer_id := NULL;
  NEW.assigned_engineer_name := NULL;
  NEW.assigned_engineer_email := NULL;
  NEW.engineer_approved_at := NULL;
  NEW.closed_at := NULL;
  NEW.archived_at := NULL;
  NEW.archive_id := NULL;
  -- DF-P3 (drafting-flow GAP-106 / LEAK-9): nor is it born overdue, warned or
  -- ended — the SLA clocks and the outcome are the workflow's to stamp (a
  -- ticket born with sla_breached_at would never be on the clock).
  NEW.sla_breached_at := NULL;
  NEW.sla_breach_warned_at := NULL;
  NEW.outcome := NULL;
  -- DF-P4 (drafting-flow GAP-105): nor does it choose its library — the
  -- create route derives it from the source document and triage sets it.
  NEW.library_id := NULL;
  -- DF-P4 (drafting-flow AUTHZ-3): the requester's name is the member's own,
  -- as the create route stamps it (display name, else the email's local
  -- part) — never the payload's. (No app path inserts from a browser since
  -- DF-P2, and this script drops tickets_org_insert; this keeps the rule if
  -- a re-paste of 20261166 ever brings that policy back.)
  SELECT NULLIF(btrim(display_name), '') INTO v_name
  FROM org_members
  WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active'
  LIMIT 1;
  NEW.requester_name := COALESCE(v_name, NULLIF(split_part(COALESCE(v_email, ''), '@', 1), ''), 'Unknown');

  -- WF-15: request_type honesty. The union keeps the check-in / transition-in
  -- vocabulary (Revision / ASBUILT / RFI) working for orgs whose configured
  -- portal list doesn't include them. Unconfigured orgs keep free vocabulary.
  SELECT array_agg(o->>'value') INTO v_types
  FROM org_configurations c,
       jsonb_array_elements(c.data->'requestTypes'->'options') o
  WHERE c.org_id = NEW.org_id AND c.key = 'drafting'
    AND jsonb_typeof(c.data->'requestTypes'->'options') = 'array';
  IF v_types IS NOT NULL AND array_length(v_types, 1) > 0
     AND NOT (NEW.request_type = ANY(v_types))
     AND NEW.request_type NOT IN ('Revision', 'ASBUILT', 'RFI') THEN
    RAISE EXCEPTION 'tickets: request type "%" is not one this workspace offers', NEW.request_type;
  END IF;

  RETURN NEW;
END;
$$;
-- CREATE OR REPLACE keeps the function trg_ticket_insert_integrity runs; the
-- trigger is restated so a database missing it gets it back.
DROP TRIGGER IF EXISTS trg_ticket_insert_integrity ON tickets;
CREATE TRIGGER trg_ticket_insert_integrity
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION ticket_insert_integrity();
-- DRLS-16: a trigger function is executable by no client role.
REVOKE ALL ON FUNCTION ticket_insert_integrity() FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. AUTHZ-3: no ticket is inserted by a signed-in client ────────────────
DROP POLICY IF EXISTS tickets_org_insert ON tickets;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'GAP-105: tickets.library_id exists (uuid), references libraries ON DELETE SET NULL, indexed' AS check,
       (EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'library_id' AND data_type = 'uuid')
        AND EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
                     WHERE c.conrelid = 'public.tickets'::regclass AND c.contype = 'f' AND a.attname = 'library_id'
                       AND c.confrelid = 'public.libraries'::regclass AND c.confdeltype = 'n')
        AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tickets' AND indexname = 'tickets_library_idx')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'GAP-105: the backfill left no ticket without the library of its own-org source document',
       NOT EXISTS (SELECT 1 FROM tickets t JOIN documents d
                     ON d.id::text = t.metadata->'source_document'->>'id' AND d.org_id = t.org_id
                    WHERE t.library_id IS NULL AND d.library_id IS NOT NULL
                      AND (t.metadata->'source_document'->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
       NULL
UNION ALL
SELECT 'ticket_update_guard: library_id workflow-owned (the library''s own deletion passes), outcome and the departure pass kept; SECURITY DEFINER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_update_guard' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_update_guard' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%v_bad := array_append(v_bad, ''library_id'');%'
                  AND p.prosrc LIKE '%NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = OLD.library_id)%'
                  AND p.prosrc LIKE '%array_append(v_bad, ''outcome''); END IF;%'
                  AND p.prosrc LIKE '%app.ticket_departure%'
                  AND p.prosrc LIKE '%tickets: last_modified cannot be cleared%'),
       NULL
UNION ALL
SELECT 'ticket_insert_integrity: a client insert is born with no library and the member''s own name; no SLA stamps, no outcome (kept); SECURITY DEFINER, search_path pinned, trigger enabled',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_trigger tg ON tg.tgfoid = p.oid
                WHERE p.proname = 'ticket_insert_integrity' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND tg.tgrelid = 'public.tickets'::regclass AND tg.tgname = 'trg_ticket_insert_integrity' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%NEW.library_id := NULL;%'
                  AND p.prosrc LIKE '%NEW.requester_name := COALESCE(v_name,%'
                  AND p.prosrc LIKE '%NEW.sla_breached_at := NULL;%'
                  AND p.prosrc LIKE '%NEW.outcome := NULL;%'),
       NULL
UNION ALL
SELECT 'DRLS-16: neither trigger function is executable by anon or authenticated',
       NOT has_function_privilege('anon', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_update_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_insert_integrity()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_insert_integrity()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'AUTHZ-3: no INSERT policy is left on tickets (tickets_org_insert dropped; the create route inserts as the service role)',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND cmd IN ('INSERT', 'ALL')),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_208_before ORDER BY ord) b
UNION ALL
SELECT 'after: tickets carrying a library', NULL, (SELECT COUNT(*) FROM tickets WHERE library_id IS NOT NULL)::text
UNION ALL
SELECT 'after: open tickets with no library (triage sets one; never required)', NULL,
       (SELECT COUNT(*) FROM tickets WHERE library_id IS NULL AND status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL)::text;
