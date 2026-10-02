-- ─────────────────────────────────────────────────────────────────────────────
-- 20261166_df_roundG_ticket_rails.sql
--
-- drafting-flow Round G — DF-P1 RAILS: the ticket row's remaining rails.
--
--   (1) ticket_update_guard RE-CREATED FROM ITS NEWEST BODY (20261038 — found
--       by scanning; lineDiff-pinned: every line of the base is kept, the
--       lines added are exactly DF-P1's). It now decides EVERY column of
--       tickets a client (auth.uid() IS NOT NULL) can write — all 41:
--         * workflow / service-owned (refused): the 22 it already owned, and
--           id, title, description, request_type, unit (LEAK-10, LEAK-3,
--           AUTHZ-6 — the whole DEC-13 resource), attachments, comments,
--           metadata (DCW-4 / HAND-3's deliverable state, SM-14's source
--           document), watchers, search_keywords, search_tsv,
--           target_completion_at, sla_breach_warned_at, sla_breached_at,
--           updated_at (SM-2's census);
--         * client-writable in the shape the app still uses: priority (the
--           queue's mark-urgent, free); last_modified (stamped, never cleared
--           — EDGE-15); unread_by (only the caller's own marker leaves it —
--           the request page's mark-read; any client write lands as the
--           stored array minus the caller, never an error, so a stale array
--           still clears the caller's marker and nobody else's); history
--           (append only: the entries already there are immutable, and an
--           appended entry names the caller — EVID-1 / AUTHZ-2 / PERS-1).
--       The service role (every route) passes, as before.
--   (2) PERS-1 done-when 3: tickets_org_access (FOR ALL, USING only — the
--       newest body is supabase/schema.sql's; no migration replaced it) is
--       split into one policy per verb with its WITH CHECK written down. The
--       USING is the same expression byte for byte; INSERT's check adds the
--       contract ticket_insert_integrity already enforces (the requester is
--       the caller). tickets_delete_controllers (RESTRICTIVE) is unchanged.
--   (3) AUTHZ-13 (DEC-44 (DF-P1)): who sees which tickets. Every member role
--       keeps the org-wide read (the product model); ONLY a member whose
--       whole collection is Contractor is narrowed — to tickets they
--       requested, are assigned to (drafter or engineer), follow, or were
--       mentioned on — by a RESTRICTIVE SELECT policy on tickets and the same
--       scope on ticket_comments (the second copy of every thread). The
--       row-independent leg (the caller's Contractor-only orgs) runs once per
--       statement, so no other member pays a per-row function call.
--   (4) AUTHZ-8: post_ticket_comment re-created from its newest body
--       (20260810): a signed-in caller's comment is stamped with THEIR uid,
--       member email, role and the time now; unread_by and watchers are
--       merged, never replaced; EXECUTE is revoked from authenticated (and
--       PUBLIC, anon) on every overload — the comment route, under the
--       service role, is the only caller (census: app/api/tickets/comment).
--   (5) PERS-4: document_intents.ticket_id → tickets(id) ON DELETE CASCADE
--       (NOT VALID when orphans already exist — every new row bound, the
--       residue counted, never deleted; the intents decay on their own TTL).
--   (6) SM-9 done-when 2: append_ticket_redline (new) — the intake portal's
--       redline lands as a `||` append of one attachment and one history
--       entry, never a whole-array replace; service role only.
--
-- NOT a widening: every change refuses or narrows (the policy split keeps
-- the same USING). DEC-30 inventory (aggregate counts only, captured BEFORE
-- the transaction): LEAK-10's count of orgs whose stored policy scopes
-- ticket.engineer_gate_exempt / ticket.direct_approve by request type or
-- unit (n > 0 raises LEAK-10 to CRITICAL — report it); tickets whose
-- request_type is outside their org's configured list today; tickets with a
-- NULL last_modified (EDGE-15); tickets recording a "published" deliverable
-- the register does not back (DCW-4 / HAND-3); the Contractor-only members
-- and the (member, ticket) reads the new scope removes (AUTHZ-13);
-- post_ticket_comment overloads a signed-in member could execute (AUTHZ-8);
-- document_intents rows naming a ticket that no longer exists (PERS-4).
--
-- HOW TO APPLY: after 20261038 and 20261039 (both LIVE) — the first statement
-- refuses to run, changing nothing, without 20261038's guard. Paste in either
-- order relative to the DF-P1 app deploy: the app keeps working with or
-- without it (no browser path writes a column this refuses — census in
-- lib/__tests__/dfRoundG_P1_rails.test.ts — and every route writes as the
-- service role). ⚠ DF-P3 / P4 / P6 / P7 / P8 each re-create
-- ticket_update_guard FROM THIS BODY; never re-paste 20261038 after this —
-- it would drop every rail added here.
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'ticket_update_guard'
                  AND prosrc LIKE '%the history log cannot shrink%') THEN
    RAISE EXCEPTION '20261166 needs 20261038 (the ticket workflow rails) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS df_round_g_166_before;
CREATE TEMP TABLE df_round_g_166_before AS
WITH contractor_only AS (
  SELECT m.org_id, m.uid
    FROM org_members m
   WHERE m.status = 'active'
     AND (CASE WHEN cardinality(m.roles) > 0 THEN m.roles ELSE ARRAY[m.role] END) <@ ARRAY['Contractor']::text[]
)
SELECT 'inventory (before apply): LEAK-10 — orgs with a type- or unit-scoped ticket.engineer_gate_exempt / ticket.direct_approve rule (n > 0 raises LEAK-10 to CRITICAL; over-counts, never under-counts)' AS inventory,
       COUNT(*)::text AS n
  FROM org_configurations
 WHERE key = 'capability_policy'
   AND (COALESCE(data -> 'caps' ->> 'ticket.engineer_gate_exempt', '') ~ '"(requestType|unit)"'
     OR COALESCE(data -> 'caps' ->> 'ticket.direct_approve', '') ~ '"(requestType|unit)"')
UNION ALL
SELECT 'inventory (before apply): LEAK-3 — tickets whose request_type is outside their org''s configured list and the built-in Revision / ASBUILT / RFI (re-typed after filing, or a type the org has since removed; kept, never rewritten)',
       COUNT(*)::text
  FROM tickets t
 WHERE t.request_type NOT IN ('Revision', 'ASBUILT', 'RFI')
   AND EXISTS (SELECT 1 FROM org_configurations c
                WHERE c.org_id = t.org_id AND c.key = 'drafting'
                  AND jsonb_typeof(c.data -> 'requestTypes' -> 'options') = 'array'
                  AND jsonb_array_length(c.data -> 'requestTypes' -> 'options') > 0)
   AND NOT EXISTS (SELECT 1 FROM org_configurations c
                    CROSS JOIN LATERAL jsonb_array_elements(
                      CASE WHEN jsonb_typeof(c.data -> 'requestTypes' -> 'options') = 'array'
                           THEN c.data -> 'requestTypes' -> 'options' ELSE '[]'::jsonb END) AS o(opt)
                    WHERE c.org_id = t.org_id AND c.key = 'drafting' AND o.opt ->> 'value' = t.request_type)
UNION ALL
SELECT 'inventory (before apply): EDGE-15 — tickets whose last_modified is NULL (the route now compare-and-sets on the null itself; the first write stamps it)',
       COUNT(*)::text
  FROM tickets WHERE last_modified IS NULL
UNION ALL
SELECT 'inventory (before apply): DCW-4 / HAND-3 — tickets with a source document recording a "published" deliverable the register does not back (no document_versions row of that id, of that source document, in the ticket''s org, carrying the ticket as its provenance — the close''s own predicate); a close now records them as not in the register',
       COUNT(*)::text
  FROM tickets t
 WHERE t.metadata -> 'deliverable' ->> 'state' = 'published'
   AND COALESCE(t.metadata -> 'source_document' ->> 'id', '') <> ''
   AND NOT EXISTS (SELECT 1 FROM document_versions v
                    WHERE v.id::text = t.metadata -> 'deliverable' ->> 'version_id'
                      AND v.org_id = t.org_id AND v.related_ticket_id = t.id
                      AND v.record_id::text = t.metadata -> 'source_document' ->> 'id')
UNION ALL
SELECT 'inventory (before apply): AUTHZ-13 — active members whose whole role collection is Contractor (narrowed to the tickets they requested, are assigned to, follow or were mentioned on)',
       COUNT(*)::text
  FROM contractor_only
UNION ALL
SELECT 'inventory (before apply): AUTHZ-13 — (Contractor-only member, ticket) reads the new scope removes (tickets in their org they did not request, are not assigned to, do not follow; mentions not subtracted — an upper bound)',
       COUNT(*)::text
  FROM contractor_only c
  JOIN tickets t ON t.org_id = c.org_id
 WHERE t.requester_id IS DISTINCT FROM c.uid
   AND t.assigned_drafter_id IS DISTINCT FROM c.uid
   AND t.assigned_engineer_id IS DISTINCT FROM c.uid
   AND NOT (c.uid = ANY (COALESCE(t.watchers, '{}'::uuid[])))
UNION ALL
SELECT 'inventory (before apply): AUTHZ-8 — post_ticket_comment overloads a signed-in member could execute (0 after this paste)',
       COUNT(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
UNION ALL
SELECT 'inventory (before apply): PERS-4 — document_intents rows naming a ticket that no longer exists (n > 0: the foreign key is added NOT VALID — new rows bound, these kept until their TTL)',
       COUNT(*)::text
  FROM document_intents i
 WHERE i.ticket_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = i.ticket_id);

BEGIN;

-- ── 0. Every column this script references exists (20261039's lesson: a
--       plpgsql body is late-bound, so a missing column fails at the first
--       UPDATE, not at the paste). Types as supabase/schema.sql and the
--       migrations define them; IF NOT EXISTS leaves an existing column alone.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS request_type TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority INT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_role TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_drafter_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_drafter_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_email TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_review_requested_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_approved_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_review_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS history JSONB DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS unread_by UUID[] DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS revision_count INT DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS search_keywords TEXT[] DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS search_tsv tsvector;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS watchers UUID[] DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS target_completion_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breach_warned_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archive_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_modified TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deliverable_rev TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS draft_iteration INT NOT NULL DEFAULT 0;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS mentioned_uids UUID[] DEFAULT '{}';
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE document_intents ADD COLUMN IF NOT EXISTS ticket_id UUID;

-- ── 1. ticket_update_guard — re-created from 20261038 (lineDiff-pinned) ─────
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

-- ── 2. PERS-1 done-when 3: one policy per verb, WITH CHECK written down ─────
-- The base is supabase/schema.sql's (no migration replaced it):
--   CREATE POLICY "tickets_org_access" ON tickets FOR ALL
--     USING (org_id IN (SELECT my_org_ids()));
-- Every USING below is that expression; every write half now SAYS its check
-- instead of inheriting USING. INSERT adds the contract
-- ticket_insert_integrity (20261038) already enforces — it stamps
-- requester_id := auth.uid() BEFORE this check runs — so a ticket is filed
-- by its requester or not at all. DELETE keeps tickets_delete_controllers
-- (RESTRICTIVE, 20261038) on top.
DROP POLICY IF EXISTS "tickets_org_access" ON tickets;
DROP POLICY IF EXISTS tickets_org_select ON tickets;
CREATE POLICY tickets_org_select ON tickets FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
DROP POLICY IF EXISTS tickets_org_insert ON tickets;
CREATE POLICY tickets_org_insert ON tickets FOR INSERT
  WITH CHECK (org_id IN (SELECT my_org_ids()) AND requester_id = auth.uid());
DROP POLICY IF EXISTS tickets_org_update ON tickets;
CREATE POLICY tickets_org_update ON tickets FOR UPDATE
  USING (org_id IN (SELECT my_org_ids()))
  WITH CHECK (org_id IN (SELECT my_org_ids()));
DROP POLICY IF EXISTS tickets_org_delete ON tickets;
CREATE POLICY tickets_org_delete ON tickets FOR DELETE
  USING (org_id IN (SELECT my_org_ids()));

-- ── 3. AUTHZ-13 (DEC-44 (DF-P1)): the Contractor collection's read scope ────
-- A member whose WHOLE collection is Contractor (headline Contractor with no
-- additive role, or every additive role Contractor) reads a ticket only when
-- they requested it, are its drafter or engineer, follow it, or were
-- mentioned on it. Everyone else keeps the org-wide read (the product model).
--
-- Cost: the row-independent part is one call per STATEMENT, not per row.
-- contractor_only_org_ids() returns the caller's Contractor-only orgs, and the
-- policy reads it through a scalar sub-select, so the planner runs it once as
-- an InitPlan. A row in any other org passes on the first leg, so a
-- non-Contractor member pays one membership lookup per query and no
-- per-row function call. Only the mention leg calls a function per row
-- (ticket_mentions_me), and only for a Contractor-only caller's rows that no
-- cheaper leg admitted. Both functions are SECURITY DEFINER (search_path
-- pinned) so the membership and mention reads do not recurse into the
-- row-level policies of the tables they read. With no session both answer
-- nothing: no org, no mention. The policies bind the authenticated role only:
-- anon reads no ticket under the org policy anyway and may not execute the
-- functions (DRLS-16), so they never appear in an anon query's plan.
-- /api/tickets/watch and /api/tickets/comment run as the service role and
-- write watchers, which is one of the scope's legs. They ask
-- lib/ticketReadScope.ts, the same predicate in TypeScript, before writing.
CREATE OR REPLACE FUNCTION contractor_only_org_ids()
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(m.org_id), '{}'::uuid[])
    FROM org_members m
   WHERE auth.uid() IS NOT NULL
     AND m.uid = auth.uid() AND m.status = 'active'
     AND (CASE WHEN cardinality(m.roles) > 0 THEN m.roles ELSE ARRAY[m.role] END) <@ ARRAY['Contractor']::text[];
$$;
REVOKE ALL ON FUNCTION contractor_only_org_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION contractor_only_org_ids() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION ticket_mentions_me(p_ticket uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM ticket_comments c
     WHERE c.ticket_id = p_ticket AND auth.uid() = ANY (COALESCE(c.mentioned_uids, '{}'::uuid[]))
  );
$$;
REVOKE ALL ON FUNCTION ticket_mentions_me(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ticket_mentions_me(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS tickets_read_scope ON tickets;
CREATE POLICY tickets_read_scope ON tickets
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (org_id = ANY ((SELECT contractor_only_org_ids())::uuid[]))
    OR requester_id = (SELECT auth.uid())
    OR assigned_drafter_id = (SELECT auth.uid())
    OR assigned_engineer_id = (SELECT auth.uid())
    OR (SELECT auth.uid()) = ANY (COALESCE(watchers, '{}'::uuid[]))
    OR ticket_mentions_me(id)
  );

-- The second copy of every thread. A comment in an org where the caller is
-- not Contractor-only passes on the first leg, so only a Contractor-only
-- caller's comments consult their ticket, and the tickets policies above
-- decide that, evaluated as the caller.
DROP POLICY IF EXISTS ticket_comments_read_scope ON ticket_comments;
CREATE POLICY ticket_comments_read_scope ON ticket_comments
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT (org_id = ANY ((SELECT contractor_only_org_ids())::uuid[]))
    OR EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_comments.ticket_id)
  );

-- ── 4. AUTHZ-8: post_ticket_comment — re-created from 20260810 ──────────────
CREATE OR REPLACE FUNCTION post_ticket_comment(
  p_ticket_id UUID,
  p_comment   JSONB,
  p_unread    UUID[],
  p_watchers  UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org      UUID;
  v_archived TIMESTAMPTZ;
  v_email    TEXT;
  v_role     TEXT;
  v_roles    TEXT[];
  v_author   UUID;
BEGIN
  SELECT org_id, archived_at INTO v_org, v_archived FROM tickets WHERE id = p_ticket_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'ticket is archived; restore it before commenting';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_org AND uid = auth.uid() AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'not an active member of this org';
  END IF;

  -- DF-P1 (AUTHZ-8): identity is never the caller's to name. A signed-in
  -- caller's comment carries THEIR uid, member email, headline role (the
  -- label the thread shows, as the route stamps it) with the whole role
  -- collection beside it, and the time now — whatever the payload said — in
  -- both the ticket_comments row and the JSONB thread. The service role (the
  -- comment route, the only caller once EXECUTE is revoked from authenticated
  -- below) stamps identity itself.
  IF auth.uid() IS NOT NULL THEN
    SELECT email, role, roles INTO v_email, v_role, v_roles FROM org_members
     WHERE org_id = v_org AND uid = auth.uid() AND status = 'active' LIMIT 1;
    p_comment := COALESCE(p_comment, '{}'::jsonb)
                 || jsonb_build_object('authorUid', auth.uid(), 'user', v_email, 'role', v_role,
                                       'roles', to_jsonb(COALESCE(v_roles, '{}'::text[])), 'date', NOW());
  END IF;
  v_author := COALESCE(auth.uid(), (p_comment->>'authorUid')::uuid);

  INSERT INTO ticket_comments (id, org_id, ticket_id, author_uid, author_email, author_role, body, type, category, mentioned_uids, created_at)
  VALUES (
    COALESCE((p_comment->>'id')::uuid, gen_random_uuid()),
    v_org,
    p_ticket_id,
    COALESCE((p_comment->>'authorUid')::uuid, auth.uid()),
    p_comment->>'user',
    p_comment->>'role',
    COALESCE(p_comment->>'text', ''),
    COALESCE(p_comment->>'type', 'General'),
    p_comment->>'category',
    COALESCE(
      (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_comment->'mentionedUserIds', '[]'::jsonb)) AS x),
      '{}'::uuid[]
    ),
    COALESCE((p_comment->>'date')::timestamptz, NOW())
  );

  UPDATE tickets
     SET comments      = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(p_comment),
         -- DF-P1 (AUTHZ-8 done-when 2): merged, never replaced — a comment adds
         -- readers and followers; it cannot drop anyone's unread marker or
         -- follow (the poster's own marker clears: they have seen it).
         unread_by     = ARRAY(SELECT DISTINCT r.id
                                 FROM unnest(COALESCE(unread_by, '{}'::uuid[]) || COALESCE(p_unread, '{}'::uuid[])) AS r(id)
                                WHERE r.id IS DISTINCT FROM v_author),
         watchers      = ARRAY(SELECT DISTINCT w.id
                                 FROM unnest(COALESCE(watchers, '{}'::uuid[]) || COALESCE(p_watchers, '{}'::uuid[])) AS w(id)),
         last_modified = NOW()
   WHERE id = p_ticket_id;
END$$;
-- EXECUTE: the comment route (service role) is the only caller — revoke
-- authenticated, anon and PUBLIC on the signature re-created here, and on
-- EVERY other overload present (whatever signature is live), and restate the
-- service role's grant.
REVOKE EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) TO service_role;
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$$;

-- ── 4b. SM-9 done-when 2: the intake redline is an APPEND, not a replace ────
-- The intake portal's redline branch (app/api/intake/upload/route.ts, the
-- service role) appends one attachment and one history entry with `||` in a
-- single UPDATE — like post_ticket_comment — so it cannot overwrite arrays a
-- workflow action wrote after the route read the row. New function (no
-- earlier body). The service role is the only caller: a signed-in caller is
-- refused inside, and EXECUTE is granted to service_role alone. Returns
-- whether the ticket (in that org, not an archived stub) took the append.
CREATE OR REPLACE FUNCTION append_ticket_redline(p_ticket_id UUID, p_org_id UUID, p_attachment JSONB, p_history JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'append_ticket_redline: only the intake route, under the service key, may call this' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_attachment) IS DISTINCT FROM 'object' OR jsonb_typeof(p_history) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'append_ticket_redline: one attachment object and one history object are required' USING ERRCODE = '22023';
  END IF;
  UPDATE tickets
     SET attachments   = COALESCE(attachments, '[]'::jsonb) || jsonb_build_array(p_attachment),
         history       = COALESCE(history, '[]'::jsonb) || jsonb_build_array(p_history),
         last_modified = NOW()
   WHERE id = p_ticket_id AND org_id = p_org_id AND archived_at IS NULL;
  RETURN FOUND;
END$$;
REVOKE ALL ON FUNCTION append_ticket_redline(UUID, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION append_ticket_redline(UUID, UUID, JSONB, JSONB) TO service_role;

-- ── 5. PERS-4: an intent cannot outlive its ticket ──────────────────────────
-- Two worlds (DEC-30): orphans already present → NOT VALID (every new and
-- updated row bound; the residue counted above and kept until its TTL);
-- none → validated now.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'document_intents_ticket_id_fkey'
                    AND conrelid = 'document_intents'::regclass) THEN
    IF EXISTS (SELECT 1 FROM document_intents i
                WHERE i.ticket_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = i.ticket_id)) THEN
      ALTER TABLE document_intents ADD CONSTRAINT document_intents_ticket_id_fkey
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE NOT VALID;
    ELSE
      ALTER TABLE document_intents ADD CONSTRAINT document_intents_ticket_id_fkey
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
    END IF;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS document_intents_ticket_idx ON document_intents(ticket_id) WHERE ticket_id IS NOT NULL;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 13. Inventory rows: n = the aggregate count (or the
-- world taken). pg_proc.prosrc is verbatim (an apostrophe inside a body's
-- string literal is '''' here); pg_policies.qual / with_check are deparsed.
SELECT 'SM-2 / LEAK-10 / LEAK-3 / DCW-4: ticket_update_guard refuses a client change to the 15 columns DF-P1 adds (id, title, description, request_type, unit, attachments, comments, metadata, watchers, search_keywords, search_tsv, target_completion_at, sla_breach_warned_at, sla_breached_at, updated_at)' AS check,
       (SELECT bool_and(p.prosrc LIKE '%IF NEW.' || c.col || ' %IS DISTINCT FROM OLD.' || c.col || ' %THEN v_bad := array_append(v_bad, ''' || c.col || ''');%')
          FROM pg_proc p
         CROSS JOIN unnest(ARRAY['id','title','description','request_type','unit','attachments','comments','metadata','watchers',
                                 'search_keywords','search_tsv','target_completion_at','sla_breach_warned_at','sla_breached_at','updated_at']) AS c(col)
         WHERE p.proname = 'ticket_update_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'WF-2 (20261038) survives the re-create: the 22 workflow-owned columns, the service-role pass and the shrink block',
       (SELECT bool_and(p.prosrc LIKE '%IF NEW.' || c.col || ' %IS DISTINCT FROM OLD.' || c.col || ' %THEN v_bad := array_append(v_bad, ''' || c.col || ''');%')
               AND bool_and(p.prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%')
               AND bool_and(p.prosrc LIKE '%RAISE EXCEPTION ''tickets: the history log cannot shrink'';%')
          FROM pg_proc p
         CROSS JOIN unnest(ARRAY['org_id','ticket_id','status','requester_id','requester_role','requester_name','requester_email',
                                 'assigned_drafter_id','assigned_drafter_name','assigned_engineer_id','assigned_engineer_name',
                                 'assigned_engineer_email','engineer_review_requested_at','engineer_approved_at','engineer_review_reason',
                                 'deliverable_rev','draft_iteration','revision_count','closed_at','archived_at','archive_id','created_at']) AS c(col)
         WHERE p.proname = 'ticket_update_guard'),
       NULL
UNION ALL
SELECT 'EVID-1 / AUTHZ-2 / PERS-1 / EDGE-15: history is append-only in the caller''s name, unread_by loses only the caller''s marker, last_modified is never cleared by a client',
       (SELECT prosrc LIKE '%WHERE h.ordinality <= v_old_len), ''[]''::jsonb)%IS DISTINCT FROM COALESCE(OLD.history, ''[]''::jsonb) THEN%RAISE EXCEPTION ''tickets: history entries cannot be changed — the log is append-only'';%'
           AND prosrc LIKE '%IF (v_entry->>''user'') IS DISTINCT FROM v_email%AND (v_entry->>''user'') IS DISTINCT FROM auth.uid()::text THEN%'
           AND prosrc LIKE '%NEW.unread_by := array_remove(COALESCE(OLD.unread_by, ''{}''::uuid[]), auth.uid());%'
           AND prosrc LIKE '%IF NEW.last_modified IS NULL AND OLD.last_modified IS NOT NULL THEN%'
           AND prosrc NOT LIKE '%v_bad := array_append(v_bad, ''priority'')%'
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
SELECT 'every column the guard decides exists on tickets (all 41 — late-bound plpgsql safety)',
       (SELECT COUNT(*) = 41 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name IN
          ('org_id','ticket_id','status','requester_id','requester_role','requester_name','requester_email',
           'assigned_drafter_id','assigned_drafter_name','assigned_engineer_id','assigned_engineer_name',
           'assigned_engineer_email','engineer_review_requested_at','engineer_approved_at','engineer_review_reason',
           'deliverable_rev','draft_iteration','revision_count','closed_at','archived_at','archive_id','created_at',
           'id','title','description','request_type','unit','attachments','comments','metadata','watchers',
           'search_keywords','search_tsv','target_completion_at','sla_breach_warned_at','sla_breached_at','updated_at',
           'priority','last_modified','unread_by','history')),
       NULL
UNION ALL
SELECT 'PERS-1 done-when 3: tickets_org_access (FOR ALL) is gone; one permissive policy per verb, each USING / WITH CHECK the org-membership expression, INSERT''s check naming the requester; tickets_delete_controllers is still RESTRICTIVE',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_org_access')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_org_select'
                    AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND qual LIKE '%my_org_ids()%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_org_insert'
                    AND cmd = 'INSERT' AND permissive = 'PERMISSIVE' AND with_check LIKE '%my_org_ids()%' AND with_check LIKE '%requester_id = auth.uid()%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_org_update'
                    AND cmd = 'UPDATE' AND permissive = 'PERMISSIVE' AND qual LIKE '%my_org_ids()%' AND with_check LIKE '%my_org_ids()%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_org_delete'
                    AND cmd = 'DELETE' AND permissive = 'PERMISSIVE' AND qual LIKE '%my_org_ids()%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_delete_controllers'
                    AND cmd = 'DELETE' AND permissive = 'RESTRICTIVE')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND cmd = 'ALL'),
       NULL
UNION ALL
SELECT 'AUTHZ-13 (DEC-44 (DF-P1)): a RESTRICTIVE read scope on tickets and on ticket_comments (authenticated) whose row-independent leg is a per-statement sub-select; both scope functions are SECURITY DEFINER with search_path pinned, executable by authenticated, not by anon or PUBLIC',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tickets' AND policyname = 'tickets_read_scope'
                AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE' AND roles = ARRAY['authenticated']::name[]
                AND qual LIKE '%SELECT contractor_only_org_ids()%' AND qual LIKE '%ticket_mentions_me(id)%'
                AND qual LIKE '%requester_id = ( SELECT auth.uid()%' AND qual LIKE '%watchers%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_comments' AND policyname = 'ticket_comments_read_scope'
                    AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE' AND roles = ARRAY['authenticated']::name[]
                    AND qual LIKE '%SELECT contractor_only_org_ids()%' AND qual LIKE '%FROM tickets t%')
       AND (SELECT COUNT(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('contractor_only_org_ids', 'ticket_mentions_me')
               AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT prosrc LIKE '%<@ ARRAY[''Contractor'']::text[]%' FROM pg_proc WHERE proname = 'contractor_only_org_ids')
       AND has_function_privilege('authenticated', 'contractor_only_org_ids()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'contractor_only_org_ids()', 'EXECUTE')
       AND has_function_privilege('authenticated', 'ticket_mentions_me(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'ticket_mentions_me(uuid)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname IN ('contractor_only_org_ids', 'ticket_mentions_me') AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'AUTHZ-8: post_ticket_comment stamps a signed-in caller''s identity over the payload and merges unread_by / watchers (never replaces them)',
       (SELECT prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%p_comment := COALESCE(p_comment, ''{}''::jsonb)%jsonb_build_object(''authorUid'', auth.uid(), ''user'', v_email, ''role'', v_role,%''date'', NOW());%'
           AND prosrc LIKE '%unread_by     = ARRAY(SELECT DISTINCT r.id%WHERE r.id IS DISTINCT FROM v_author),%'
           AND prosrc LIKE '%watchers      = ARRAY(SELECT DISTINCT w.id%'
           AND prosrc NOT LIKE '%COALESCE(p_unread, unread_by)%'
           AND prosrc LIKE '%RAISE EXCEPTION ''ticket is archived; restore it before commenting'';%'
          FROM pg_proc WHERE proname = 'post_ticket_comment'
          ORDER BY oid DESC LIMIT 1),
       NULL
UNION ALL
SELECT 'AUTHZ-8: no post_ticket_comment overload is executable by authenticated, anon or PUBLIC; the service role can execute every one',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
                      AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           OR has_function_privilege('anon', p.oid, 'EXECUTE')
                           OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE')))
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'post_ticket_comment'),
       NULL
UNION ALL
SELECT 'post_ticket_comment is SECURITY DEFINER with search_path pinned',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
                      AND NOT (p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])),
       NULL
UNION ALL
SELECT 'SM-9: append_ticket_redline appends with || (never a replace), is SECURITY DEFINER with search_path pinned, and only the service role can execute it',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'append_ticket_redline'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                  AND p.prosrc LIKE '%attachments   = COALESCE(attachments, ''[]''::jsonb) || jsonb_build_array(p_attachment),%'
                  AND p.prosrc LIKE '%history       = COALESCE(history, ''[]''::jsonb) || jsonb_build_array(p_history),%')
       AND has_function_privilege('service_role', 'append_ticket_redline(uuid, uuid, jsonb, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'append_ticket_redline(uuid, uuid, jsonb, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'append_ticket_redline(uuid, uuid, jsonb, jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'PERS-4: document_intents.ticket_id references tickets(id) ON DELETE CASCADE',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'document_intents_ticket_id_fkey' AND conrelid = 'document_intents'::regclass
                  AND confrelid = 'tickets'::regclass AND contype = 'f' AND confdeltype = 'c'),
       NULL
UNION ALL
SELECT 'ticket_insert_integrity (20261038) is still installed BEFORE INSERT — it stamps the requester the INSERT policy checks',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_insert_integrity'
                AND tgrelid = 'tickets'::regclass AND NOT tgisinternal),
       NULL
UNION ALL
SELECT 'world taken (PERS-4): the foreign key is validated, or NOT VALID over pre-existing orphans',
       NULL::boolean,
       (SELECT CASE WHEN convalidated THEN 'validated' ELSE 'NOT VALID (orphans kept until their TTL)' END
          FROM pg_constraint WHERE conname = 'document_intents_ticket_id_fkey' AND conrelid = 'document_intents'::regclass)
UNION ALL
SELECT inventory, NULL::boolean, n FROM df_round_g_166_before;
